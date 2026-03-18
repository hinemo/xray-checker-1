package main

import (
	"fmt"
	"net/http"
	"os"
	"path/filepath"
	"sync"
	"time"
	"xray-checker/checker"
	"xray-checker/config"
	"xray-checker/logger"
	"xray-checker/metrics"
	"xray-checker/models"
	"xray-checker/storage"
	"xray-checker/subscription"
	"xray-checker/web"
	"xray-checker/xray"

	"github.com/go-co-op/gocron"
	"github.com/prometheus/client_golang/prometheus"
	"github.com/prometheus/client_golang/prometheus/promhttp"
)

var (
	version   = "unknown"
	startTime = time.Now()
)

type subscriptionCache struct {
	mu      sync.RWMutex
	configs map[string][]*models.ProxyConfig
	names   map[string]string
}

func newSubscriptionCache() *subscriptionCache {
	return &subscriptionCache{
		configs: make(map[string][]*models.ProxyConfig),
		names:   make(map[string]string),
	}
}

func (c *subscriptionCache) set(url string, configs []*models.ProxyConfig, name string) {
	c.mu.Lock()
	defer c.mu.Unlock()
	c.configs[url] = configs
	c.names[url] = name
}

func (c *subscriptionCache) get(url string) ([]*models.ProxyConfig, string, bool) {
	c.mu.RLock()
	defer c.mu.RUnlock()
	configs, ok := c.configs[url]
	name := c.names[url]
	return configs, name, ok
}

func fetchSubscription(url string) ([]*models.ProxyConfig, string, error) {
	configs, name, err := subscription.ReadFromSource(url)
	if err != nil {
		return nil, "", err
	}
	for _, cfg := range configs {
		cfg.SubName = name
	}
	return configs, name, nil
}

func buildConfigsFromURLs(urls []string, cache *subscriptionCache, forceFetch bool, fetchMissing bool) ([]*models.ProxyConfig, map[string]string, error) {
	allConfigs := make([]*models.ProxyConfig, 0)
	names := make(map[string]string)

	for _, url := range urls {
		var configs []*models.ProxyConfig
		var name string
		var ok bool

		if !forceFetch {
			configs, name, ok = cache.get(url)
		}

		if forceFetch || !ok {
			if !forceFetch && !fetchMissing {
				return nil, nil, fmt.Errorf("subscription cache miss: %s", url)
			}
			var err error
			configs, name, err = fetchSubscription(url)
			if err != nil {
				return nil, nil, err
			}
			cache.set(url, configs, name)
		}

		names[url] = name
		allConfigs = append(allConfigs, configs...)
	}

	if config.CLIConfig.Proxy.ResolveDomains {
		resolved, err := subscription.ResolveDomainsForConfigs(allConfigs)
		if err != nil {
			return nil, nil, err
		}
		allConfigs = resolved
	}

	for i := range allConfigs {
		allConfigs[i].Index = i
	}

	xray.PrepareProxyConfigs(allConfigs)

	return allConfigs, names, nil
}

func containsString(list []string, target string) bool {
	for _, item := range list {
		if item == target {
			return true
		}
	}
	return false
}

type scheduleManager struct {
	mu             sync.Mutex
	checkScheduler *gocron.Scheduler
	fetchScheduler *gocron.Scheduler
	settings       storage.ScheduleSettings
	checkJob       func()
	fetchJob       func()
}

func newScheduleManager(checkJob func(), fetchJob func()) *scheduleManager {
	return &scheduleManager{
		checkJob: checkJob,
		fetchJob: fetchJob,
	}
}

func (m *scheduleManager) Apply(settings storage.ScheduleSettings) {
	m.mu.Lock()
	defer m.mu.Unlock()

	m.settings = settings

	if m.checkScheduler != nil {
		m.checkScheduler.Stop()
		m.checkScheduler = nil
	}
	if m.fetchScheduler != nil {
		m.fetchScheduler.Stop()
		m.fetchScheduler = nil
	}

	if settings.AutoCheckEnabled {
		interval := time.Duration(maxInt(settings.AutoCheckMinutes, 1)) * time.Minute
		sched := gocron.NewScheduler(time.UTC)
		sched.Every(interval).Do(func() { m.checkJob() })
		sched.StartAsync()
		m.checkScheduler = sched
	}

	if settings.AutoFetchEnabled {
		interval := time.Duration(maxInt(settings.AutoFetchMinutes, 1)) * time.Minute
		sched := gocron.NewScheduler(time.UTC)
		sched.Every(interval).WaitForSchedule().Do(func() { m.fetchJob() })
		sched.StartAsync()
		m.fetchScheduler = sched
	}
}

func maxInt(a, b int) int {
	if a > b {
		return a
	}
	return b
}

func main() {
	config.Parse(version)

	logLevel := logger.ParseLevel(config.CLIConfig.LogLevel)
	logger.SetLevel(logLevel)

	logger.Startup("Xray Checker %s (Antigravity Build)", version)
	if logLevel == logger.LevelNone {
		logger.Startup("Log level: none (silent mode)")
	}

	customAssetsPath := config.CLIConfig.Web.CustomAssetsPath
	if customAssetsPath == "" {
		autoFrontendDist := filepath.Join("frontend", "dist")
		if stat, err := os.Stat(autoFrontendDist); err == nil && stat.IsDir() {
			customAssetsPath = autoFrontendDist
			logger.Info("Auto-detected frontend assets: %s", customAssetsPath)
		}
	}

	if err := web.InitAssetLoader(customAssetsPath); err != nil {
		logger.Fatal("Failed to initialize custom assets: %v", err)
	}

	geoManager := xray.NewGeoFileManager("")
	if err := geoManager.EnsureGeoFiles(); err != nil {
		logger.Fatal("Failed to ensure geo files: %v", err)
	}

	configFile := "xray_config.json"
	var dbStore *storage.SQLiteStore
	var err error

	if config.CLIConfig.Database.Enabled {
		dbStore, err = storage.NewSQLiteStore(config.CLIConfig.Database.Path)
		if err != nil {
			logger.Fatal("Failed to initialize SQLite storage: %v", err)
		}
	}

	var proxyConfigs = &[]*models.ProxyConfig{}
	var xrayRunner *xray.Runner
	var startedOnce bool
	subCache := newSubscriptionCache()

	proxyChecker := checker.NewProxyChecker(
		*proxyConfigs,
		config.CLIConfig.Xray.StartPort,
		config.CLIConfig.Proxy.IpCheckUrl,
		config.CLIConfig.Proxy.Timeout,
		config.CLIConfig.Proxy.StatusCheckUrl,
		config.CLIConfig.Proxy.DownloadUrl,
		config.CLIConfig.Proxy.DownloadTimeout,
		config.CLIConfig.Proxy.DownloadMinSize,
		config.CLIConfig.Proxy.CheckMethod,
	)

	// Initialization function that can be called repeatedly
	reinitialize := func(urls []string, refreshURL string) error {
		config.CLIConfig.Subscription.URLs = urls
		logger.Info("Starting manual configuration initialization...")
		if len(urls) == 0 {
			return fmt.Errorf("no subscription URLs provided")
		}

		var newConfigs []*models.ProxyConfig
		var subNames map[string]string
		var err error
		if refreshURL == "" {
			newConfigs, subNames, err = buildConfigsFromURLs(urls, subCache, true, true)
		} else {
			if !containsString(urls, refreshURL) {
				return fmt.Errorf("refresh url not found in subscriptions")
			}

			newConfigs = make([]*models.ProxyConfig, 0)
			subNames = make(map[string]string)
			for _, url := range urls {
				var configs []*models.ProxyConfig
				var name string
				var ok bool

				if url == refreshURL {
					configs, name, err = fetchSubscription(url)
					if err != nil {
						return fmt.Errorf("error fetching subscription: %w", err)
					}
					subCache.set(url, configs, name)
				} else {
					configs, name, ok = subCache.get(url)
					if !ok {
						configs, name, err = fetchSubscription(url)
						if err != nil {
							return fmt.Errorf("error fetching subscription: %w", err)
						}
						subCache.set(url, configs, name)
					}
				}

				subNames[url] = name
				newConfigs = append(newConfigs, configs...)
			}

			if config.CLIConfig.Proxy.ResolveDomains {
				resolved, err := subscription.ResolveDomainsForConfigs(newConfigs)
				if err != nil {
					return fmt.Errorf("error resolving domains: %w", err)
				}
				newConfigs = resolved
			}

			for i := range newConfigs {
				newConfigs[i].Index = i
			}

			xray.PrepareProxyConfigs(newConfigs)
		}

		if xrayRunner == nil {
			xrayRunner = xray.NewRunner(configFile)
		} else {
			xrayRunner.Stop()
		}

		if len(newConfigs) > 0 {
			if err := xrayRunner.Start(); err != nil {
				return fmt.Errorf("error starting Xray: %w", err)
			}
			logger.Info("Xray started with %d proxies", len(newConfigs))
		} else {
			logger.Warn("Initialized with 0 proxies. Xray runner in standby.")
		}

		proxyChecker.UpdateProxies(newConfigs)
		*proxyConfigs = newConfigs
		
		web.RegisterConfigEndpoints(*proxyConfigs, proxyChecker, config.CLIConfig.Xray.StartPort)

		if dbStore != nil {
			if err := dbStore.SyncSubscriptions(urls, subNames); err != nil {
				logger.Error("Failed to persist subscriptions: %v", err)
			}
			if err := dbStore.ReplaceNodes(*proxyConfigs); err != nil {
				logger.Error("Failed to persist nodes: %v", err)
			}
		}
		startedOnce = true
		return nil
	}

	// We only auto-initialize if explicitly told to OR if URLs are provided and we don't care about the manual start constraint.
	// But per user request: "不要自动启动获取订阅等工作" -> We don't call reinitialize here.
	logger.Info("Ready. Please use the Web UI or API to configure and start subscriptions.")

	if logLevel == logger.LevelDebug {
		logger.Debug("=== Parsed Proxy Configurations ===")
		for _, pc := range *proxyConfigs {
			logger.Debug("%s", pc.DebugString())
		}
	}

	// Xray runner will be managed by reinitialize
	defer func() {
		if xrayRunner != nil {
			xrayRunner.Stop()
		}
	}()

	metrics.InitMetrics(config.CLIConfig.Metrics.Instance)

	registry := prometheus.NewRegistry()
	registry.MustRegister(metrics.GetProxyStatusMetric())
	registry.MustRegister(metrics.GetProxyLatencyMetric())

	runCheckIteration := func() {
		logger.Info("Starting proxy check iteration")
		proxyChecker.CheckAllProxies()

		if dbStore != nil {
			if err := dbStore.SaveNodeChecks(collectCheckResults(proxyChecker)); err != nil {
				logger.Error("Failed to persist node checks: %v", err)
			}
		}

		if config.CLIConfig.Metrics.PushURL != "" {
			pushConfig, err := metrics.ParseURL(config.CLIConfig.Metrics.PushURL)
			if err != nil {
				logger.Error("Error parsing push URL: %v", err)
				return
			}

			if pushConfig != nil {
				if err := metrics.PushMetrics(pushConfig, registry); err != nil {
					logger.Error("Error pushing metrics: %v", err)
				}
			}
		}
	}

	if config.CLIConfig.RunOnce {
		runCheckIteration()
		logger.Info("Check completed")
		return
	}

	runSubscriptionUpdate := func() {
		if !startedOnce {
			logger.Debug("Subscription update skipped: not initialized")
			return
		}
		logger.Info("Checking subscriptions for updates...")

		currentURLs := config.CLIConfig.Subscription.URLs
		if len(currentURLs) == 0 && dbStore != nil {
			dbURLs, _ := dbStore.GetSubscriptions()
			currentURLs = dbURLs
		}

		if len(currentURLs) == 0 {
			logger.Debug("No subscriptions to update")
			return
		}

		newConfigs, subNames, err := buildConfigsFromURLs(currentURLs, subCache, true, true)
		if err != nil {
			logger.Error("Error fetching subscriptions: %v", err)
			return
		}

		if !xray.IsConfigsEqual(*proxyConfigs, newConfigs) {
			if err := updateConfiguration(newConfigs, proxyConfigs, xrayRunner, proxyChecker, dbStore, subNames, currentURLs); err != nil {
				logger.Error("Error updating configuration: %v", err)
			}
		} else {
			logger.Info("Subscriptions checked, no changes")
		}
	}

	scheduler := newScheduleManager(runCheckIteration, runSubscriptionUpdate)

	settings := storage.ScheduleSettings{
		AutoFetchEnabled: config.CLIConfig.Subscription.Update,
		AutoFetchMinutes: maxInt(1, (config.CLIConfig.Subscription.UpdateInterval+59)/60),
		AutoCheckEnabled: true,
		AutoCheckMinutes: maxInt(1, (config.CLIConfig.Proxy.CheckInterval+59)/60),
	}
	if dbStore != nil {
		stored, err := dbStore.GetScheduleSettings()
		if err != nil {
			logger.Error("Failed to load schedule settings: %v", err)
		} else if stored != nil {
			settings = *stored
		}
	}

	scheduler.Apply(settings)

	mux, err := web.NewPrefixServeMux(config.CLIConfig.Metrics.BasePath)
	if err != nil {
		logger.Fatal("Error creating web server: %v", err)
	}
	mux.Handle("/health", web.HealthHandler())
	mux.Handle("/static/", web.StaticHandler())
	mux.Handle("/assets/", web.StaticHandler())
	mux.Handle("/_next/", web.StaticHandler())
	mux.Handle("/favicon.svg", web.StaticHandler())
	mux.Handle("/icon.svg", web.StaticHandler())
	mux.Handle("/manifest.webmanifest", web.StaticHandler())
	mux.Handle("/sw.js", web.StaticHandler())
	mux.Handle("/api/v1/public/proxies", web.APIPublicProxiesHandler(proxyChecker))

	web.RegisterConfigEndpoints(*proxyConfigs, proxyChecker, config.CLIConfig.Xray.StartPort)

	protectedHandler := http.NewServeMux()
	protectedHandler.Handle("/metrics", promhttp.HandlerFor(registry, promhttp.HandlerOpts{}))
	protectedHandler.Handle("/config/", web.ConfigStatusHandler(proxyChecker))
	protectedHandler.Handle("/api/v1/proxies/", web.APIProxyHandler(proxyChecker, config.CLIConfig.Xray.StartPort))
	protectedHandler.Handle("/api/v1/proxies", web.APIProxiesHandler(proxyChecker, config.CLIConfig.Xray.StartPort))
	protectedHandler.Handle("/api/v1/config", web.APIConfigHandler(proxyChecker))
	protectedHandler.Handle("/api/v1/status", web.APIStatusHandler(proxyChecker))
	protectedHandler.Handle("/api/v1/system/info", web.APISystemInfoHandler(version, startTime))
	protectedHandler.Handle("/api/v1/system/ip", web.APISystemIPHandler(proxyChecker))
	protectedHandler.Handle("/api/v1/check", web.APICheckHandler(proxyChecker, dbStore))
	protectedHandler.Handle("/api/v1/reload", web.APIReloadHandler(dbStore, reinitialize))
	protectedHandler.Handle("/api/v1/subscriptions", web.APISubscriptionHandler(dbStore))
	protectedHandler.Handle("/api/v1/subscriptions/refresh", web.APISubscriptionRefreshHandler(dbStore, reinitialize))
	protectedHandler.Handle("/api/v1/subscriptions/groups", web.APISubscriptionGroupsHandler(dbStore))
	protectedHandler.Handle("/api/v1/schedule", web.APIScheduleSettingsHandler(dbStore, func(settings storage.ScheduleSettings) {
		scheduler.Apply(settings)
	}))
	protectedHandler.Handle("/api/v1/actions", web.APIActionLogsHandler(dbStore))
	protectedHandler.Handle("/api/v1/docs", web.APIDocsHandler())
	protectedHandler.Handle("/api/v1/openapi.yaml", web.APIOpenAPIHandler())

	if config.CLIConfig.Web.Public {
		mux.Handle("/", web.IndexHandler(version, proxyChecker))
		mux.Handle("/config/", web.ConfigStatusHandler(proxyChecker))
		middlewareHandler := web.BasicAuthMiddleware(
			config.CLIConfig.Metrics.Username,
			config.CLIConfig.Metrics.Password,
		)(protectedHandler)
		mux.Handle("/metrics", middlewareHandler)
		mux.Handle("/api/", middlewareHandler)
	} else if config.CLIConfig.Metrics.Protected {
		protectedHandler.Handle("/", web.IndexHandler(version, proxyChecker))
		middlewareHandler := web.BasicAuthMiddleware(
			config.CLIConfig.Metrics.Username,
			config.CLIConfig.Metrics.Password,
		)(protectedHandler)
		mux.Handle("/", middlewareHandler)
	} else {
		protectedHandler.Handle("/", web.IndexHandler(version, proxyChecker))
		mux.Handle("/", protectedHandler)
	}

	if !config.CLIConfig.RunOnce {
		logger.Info("Server listening on %s:%s%s",
			config.CLIConfig.Metrics.Host,
			config.CLIConfig.Metrics.Port,
			config.CLIConfig.Metrics.BasePath,
		)
		if err := http.ListenAndServe(config.CLIConfig.Metrics.Host+":"+config.CLIConfig.Metrics.Port, mux); err != nil {
			logger.Fatal("Error starting server: %v", err)
		}
	}
}

func updateConfiguration(newConfigs []*models.ProxyConfig, currentConfigs *[]*models.ProxyConfig,
	xrayRunner *xray.Runner, proxyChecker *checker.ProxyChecker, dbStore *storage.SQLiteStore,
	subNames map[string]string, subURLs []string) error {

	logger.Info("Subscription changed, updating configuration...")

	xray.PrepareProxyConfigs(newConfigs)

	configFile := "xray_config.json"
	configGenerator := xray.NewConfigGenerator()
	if err := configGenerator.GenerateAndSaveConfig(
		newConfigs,
		config.CLIConfig.Xray.StartPort,
		configFile,
		config.CLIConfig.Xray.LogLevel,
	); err != nil {
		return err
	}

	if err := xrayRunner.Stop(); err != nil {
		return err
	}

	if err := xrayRunner.Start(); err != nil {
		return err
	}

	proxyChecker.UpdateProxies(newConfigs)

	*currentConfigs = newConfigs

	if dbStore != nil {
		if err := dbStore.SyncSubscriptions(subURLs, subNames); err != nil {
			logger.Error("Failed to persist subscriptions: %v", err)
		}
		if err := dbStore.ReplaceNodes(newConfigs); err != nil {
			logger.Error("Failed to persist nodes: %v", err)
		}
	}

	web.RegisterConfigEndpoints(newConfigs, proxyChecker, config.CLIConfig.Xray.StartPort)

	logger.Info("Configuration updated: %d proxies", len(newConfigs))
	return nil
}

func collectCheckResults(proxyChecker *checker.ProxyChecker) []storage.NodeCheckResult {
	proxies := proxyChecker.GetProxies()
	results := make([]storage.NodeCheckResult, 0, len(proxies))

	for _, proxy := range proxies {
		if proxy.StableID == "" {
			proxy.StableID = proxy.GenerateStableID()
		}

		online, latency, err := proxyChecker.GetProxyStatusByStableID(proxy.StableID)
		if err != nil {
			online = false
			latency = 0
		}

		results = append(results, storage.NodeCheckResult{
			StableID:  proxy.StableID,
			Online:    online,
			LatencyMs: latency.Milliseconds(),
		})
	}

	return results
}
