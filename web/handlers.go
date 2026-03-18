package web

import (
	"encoding/json"
	"fmt"
	"net/http"
	"strconv"
	"strings"
	"sync"
	"time"
	"xray-checker/checker"
	"xray-checker/config"
	"xray-checker/logger"
	"xray-checker/metrics"
	"xray-checker/models"
	"xray-checker/storage"
	"xray-checker/subscription"
)

var (
	registeredEndpoints []EndpointInfo
	endpointsMu         sync.RWMutex
)

type EndpointInfo struct {
	Name       string
	ServerInfo string
	URL        string
	ProxyPort  int
	Index      int
	Status     bool
	Latency    time.Duration
	StableID   string
}

func IndexHandler(version string, proxyChecker *checker.ProxyChecker) http.HandlerFunc {
	return func(w http.ResponseWriter, r *http.Request) {
		if r.URL.Path != "/" {
			http.NotFound(w, r)
			return
		}

		RegisterConfigEndpoints(proxyChecker.GetProxies(), proxyChecker, config.CLIConfig.Xray.StartPort)

		endpointsMu.RLock()
		allEndpoints := make([]EndpointInfo, len(registeredEndpoints))
		copy(allEndpoints, registeredEndpoints)
		endpointsMu.RUnlock()

		isPublic := config.CLIConfig.Web.Public
		showServerDetails := config.CLIConfig.Web.ShowServerDetails
		if isPublic {
			showServerDetails = false
		}

		endpoints := allEndpoints
		if isPublic {
			endpoints = make([]EndpointInfo, len(allEndpoints))
			for i, ep := range allEndpoints {
				endpoints[i] = EndpointInfo{
					Name:     ep.Name,
					Index:    ep.Index,
					Status:   ep.Status,
					Latency:  ep.Latency,
					StableID: ep.StableID,
				}
			}
		}

		data := PageData{
			Version:                    version,
			Host:                       config.CLIConfig.Metrics.Host,
			Port:                       config.CLIConfig.Metrics.Port,
			CheckInterval:              config.CLIConfig.Proxy.CheckInterval,
			IPCheckUrl:                 config.CLIConfig.Proxy.IpCheckUrl,
			CheckMethod:                config.CLIConfig.Proxy.CheckMethod,
			StatusCheckUrl:             config.CLIConfig.Proxy.StatusCheckUrl,
			DownloadUrl:                config.CLIConfig.Proxy.DownloadUrl,
			SimulateLatency:            config.CLIConfig.Proxy.SimulateLatency,
			Timeout:                    config.CLIConfig.Proxy.Timeout,
			SubscriptionUpdate:         config.CLIConfig.Subscription.Update,
			SubscriptionUpdateInterval: config.CLIConfig.Subscription.UpdateInterval,
			StartPort:                  config.CLIConfig.Xray.StartPort,
			Instance:                   config.CLIConfig.Metrics.Instance,
			PushUrl:                    metrics.GetPushURL(config.CLIConfig.Metrics.PushURL),
			Endpoints:                  endpoints,
			ShowServerDetails:          showServerDetails,
			IsPublic:                   isPublic,
			SubscriptionName:           subscription.GetSubscriptionName(),
		}

		w.Header().Set("Content-Type", "text/html; charset=utf-8")
		w.Header().Set("X-Robots-Tag", "noindex, nofollow")
		if err := RenderIndex(w, data); err != nil {
			http.Error(w, err.Error(), http.StatusInternalServerError)
			return
		}
	}
}

func HealthHandler() http.HandlerFunc {
	return func(w http.ResponseWriter, r *http.Request) {
		w.WriteHeader(http.StatusOK)
		w.Write([]byte("OK"))
	}
}

func BasicAuthMiddleware(username, password string) func(http.Handler) http.Handler {
	return func(next http.Handler) http.Handler {
		return http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
			user, pass, ok := r.BasicAuth()
			if !ok || user != username || pass != password {
				w.Header().Set("WWW-Authenticate", `Basic realm="metrics"`)
				http.Error(w, "Unauthorized.", http.StatusUnauthorized)
				return
			}
			next.ServeHTTP(w, r)
		})
	}
}

func ConfigStatusHandler(proxyChecker *checker.ProxyChecker) http.HandlerFunc {
	return func(w http.ResponseWriter, r *http.Request) {
		path := r.URL.Path[len("/config/"):]
		if path == "" {
			http.Error(w, "Config path is required", http.StatusBadRequest)
			return
		}

		found, exists := proxyChecker.GetProxyByStableID(path)
		if !exists {
			http.Error(w, "Config not found", http.StatusNotFound)
			return
		}

		status, latency, err := proxyChecker.GetProxyStatus(found.Name)
		if err != nil {
			http.Error(w, "Status not available", http.StatusNotFound)
			return
		}

		if config.CLIConfig.Proxy.SimulateLatency {
			time.Sleep(time.Duration(latency))
		}

		if status {
			w.WriteHeader(http.StatusOK)
			w.Write([]byte("OK"))
		} else {
			w.WriteHeader(http.StatusServiceUnavailable)
			w.Write([]byte("Failed"))
		}
	}
}

func APICheckHandler(proxyChecker *checker.ProxyChecker, dbStore *storage.SQLiteStore) http.HandlerFunc {
	return func(w http.ResponseWriter, r *http.Request) {
		if r.Method != http.MethodPost {
			writeError(w, "Method not allowed", http.StatusMethodNotAllowed)
			return
		}

		logger.Info("Manual proxy check triggered via API")
		if dbStore != nil {
			_ = dbStore.AddActionLog("check", "started", "Manual check started")
		}
		go func() {
			proxyChecker.CheckAllProxies()
			if dbStore != nil {
				results := make([]storage.NodeCheckResult, 0)
				for _, p := range proxyChecker.GetProxies() {
					online, latency, err := proxyChecker.GetProxyStatusByStableID(p.StableID)
					if err == nil {
						results = append(results, storage.NodeCheckResult{
							StableID:  p.StableID,
							Online:    online,
							LatencyMs: latency.Milliseconds(),
						})
					}
				}
				dbStore.SaveNodeChecks(results)
			}
		}()

		writeJSON(w, map[string]string{"message": "Check started"})
	}
}

func APIReloadHandler(dbStore *storage.SQLiteStore, reinit func([]string, string) error) http.HandlerFunc {
	return func(w http.ResponseWriter, r *http.Request) {
		if r.Method != http.MethodPost {
			writeError(w, "Method not allowed", http.StatusMethodNotAllowed)
			return
		}

		if dbStore == nil {
			writeError(w, "Database is not enabled", http.StatusServiceUnavailable)
			return
		}

		urls, err := dbStore.GetSubscriptions()
		if err != nil {
			_ = dbStore.AddActionLog("reload", "failed", "Failed to load subscriptions")
			writeError(w, "Failed to load URLs from DB: "+err.Error(), http.StatusInternalServerError)
			return
		}

		if len(urls) == 0 {
			_ = dbStore.AddActionLog("reload", "failed", "No subscriptions found")
			writeError(w, "No subscription URLs found in database. Please add one first.", http.StatusBadRequest)
			return
		}

		logger.Info("Manual reload/activation triggered via API")
		if err := reinit(urls, ""); err != nil {
			_ = dbStore.AddActionLog("reload", "failed", "Re-initialization failed")
			writeError(w, "Re-initialization failed: "+err.Error(), http.StatusInternalServerError)
			return
		}

		_ = dbStore.AddActionLog("reload", "success", fmt.Sprintf("Activated %d subscriptions", len(urls)))

		writeJSON(w, map[string]string{"message": "Activation successful", "proxies": fmt.Sprintf("%d", len(urls))})
	}
}

func APISubscriptionRefreshHandler(dbStore *storage.SQLiteStore, reinit func([]string, string) error) http.HandlerFunc {
	return func(w http.ResponseWriter, r *http.Request) {
		if r.Method != http.MethodPost {
			writeError(w, "Method not allowed", http.StatusMethodNotAllowed)
			return
		}

		if dbStore == nil {
			writeError(w, "Database is not enabled", http.StatusServiceUnavailable)
			return
		}

		url := r.URL.Query().Get("url")
		urls, err := dbStore.GetSubscriptions()
		if err != nil {
			_ = dbStore.AddActionLog("subscription_refresh", "failed", "Failed to load subscriptions")
			writeError(w, "Failed to load URLs from DB: "+err.Error(), http.StatusInternalServerError)
			return
		}

		if len(urls) == 0 {
			_ = dbStore.AddActionLog("subscription_refresh", "failed", "No subscriptions found")
			writeError(w, "No subscription URLs found in database. Please add one first.", http.StatusBadRequest)
			return
		}

		if url == "" {
			writeError(w, "URL query parameter is required", http.StatusBadRequest)
			return
		}

		logger.Info("Subscription refresh triggered via API")
		if err := reinit(urls, url); err != nil {
			_ = dbStore.AddActionLog("subscription_refresh", "failed", "Re-initialization failed")
			writeError(w, "Re-initialization failed: "+err.Error(), http.StatusInternalServerError)
			return
		}

		_ = dbStore.AddActionLog("subscription_refresh", "success", "Subscription refreshed: "+url)

		writeJSON(w, map[string]string{"message": "Refresh triggered"})
	}
}

func APISubscriptionHandler(dbStore *storage.SQLiteStore) http.HandlerFunc {
	return func(w http.ResponseWriter, r *http.Request) {
		if dbStore == nil {
			writeError(w, "Database is not enabled", http.StatusServiceUnavailable)
			return
		}

		switch r.Method {
		case http.MethodPost:
			var req struct {
				URL string `json:"url"`
			}
			if err := json.NewDecoder(r.Body).Decode(&req); err != nil {
				writeError(w, "Invalid request body", http.StatusBadRequest)
				return
			}
			if req.URL == "" {
				writeError(w, "URL is required", http.StatusBadRequest)
				return
			}
			if err := dbStore.AddSubscription(req.URL); err != nil {
				_ = dbStore.AddActionLog("subscription_add", "failed", err.Error())
				writeError(w, err.Error(), http.StatusInternalServerError)
				return
			}
			_ = dbStore.AddActionLog("subscription_add", "success", req.URL)
			writeJSON(w, map[string]string{"message": "Subscription added"})

		case http.MethodDelete:
			url := r.URL.Query().Get("url")
			if url == "" {
				writeError(w, "URL query parameter is required", http.StatusBadRequest)
				return
			}
			if err := dbStore.DeleteSubscription(url); err != nil {
				_ = dbStore.AddActionLog("subscription_delete", "failed", err.Error())
				writeError(w, err.Error(), http.StatusInternalServerError)
				return
			}
			_ = dbStore.AddActionLog("subscription_delete", "success", url)
			writeJSON(w, map[string]string{"message": "Subscription deleted"})

		case http.MethodGet:
			urls, err := dbStore.GetSubscriptions()
			if err != nil {
				writeError(w, err.Error(), http.StatusInternalServerError)
				return
			}
			writeJSON(w, urls)

		default:
			writeError(w, "Method not allowed", http.StatusMethodNotAllowed)
		}
	}
}

func APISubscriptionGroupsHandler(dbStore *storage.SQLiteStore) http.HandlerFunc {
	return func(w http.ResponseWriter, r *http.Request) {
		if r.Method != http.MethodGet {
			writeError(w, "Method not allowed", http.StatusMethodNotAllowed)
			return
		}

		if dbStore == nil {
			writeError(w, "Database is not enabled", http.StatusServiceUnavailable)
			return
		}

		groups, err := dbStore.ListSubscriptionGroups()
		if err != nil {
			writeError(w, err.Error(), http.StatusInternalServerError)
			return
		}

		payload := make([]SubscriptionGroupInfo, 0, len(groups))
		for _, group := range groups {
			info := SubscriptionGroupInfo{
				Name:      group.Name,
				NodeCount: group.NodeCount,
			}
			if group.LastUpdatedAt != nil {
				info.LastUpdatedAt = group.LastUpdatedAt.UTC().Format(time.RFC3339)
			}
			if group.LastCheckedAt != nil {
				info.LastCheckedAt = group.LastCheckedAt.UTC().Format(time.RFC3339)
			}
			payload = append(payload, info)
		}

		writeJSON(w, payload)
	}
}

func APIScheduleSettingsHandler(dbStore *storage.SQLiteStore, onUpdate func(storage.ScheduleSettings)) http.HandlerFunc {
	return func(w http.ResponseWriter, r *http.Request) {
		if dbStore == nil {
			writeError(w, "Database is not enabled", http.StatusServiceUnavailable)
			return
		}

		switch r.Method {
		case http.MethodGet:
			settings, err := dbStore.GetScheduleSettings()
			if err != nil {
				writeError(w, err.Error(), http.StatusInternalServerError)
				return
			}

			response := ScheduleSettingsResponse{
				AutoFetchEnabled: false,
				AutoFetchMinutes: 30,
				AutoCheckEnabled: false,
				AutoCheckMinutes: 5,
			}
			if settings != nil {
				response.AutoFetchEnabled = settings.AutoFetchEnabled
				response.AutoFetchMinutes = settings.AutoFetchMinutes
				response.AutoCheckEnabled = settings.AutoCheckEnabled
				response.AutoCheckMinutes = settings.AutoCheckMinutes
				response.UpdatedAt = settings.UpdatedAt.UTC().Format(time.RFC3339)
			}

			writeJSON(w, response)

		case http.MethodPut:
			var req ScheduleSettingsResponse
			if err := json.NewDecoder(r.Body).Decode(&req); err != nil {
				writeError(w, "Invalid request body", http.StatusBadRequest)
				return
			}
			if req.AutoFetchMinutes < 1 || req.AutoCheckMinutes < 1 {
				writeError(w, "Minutes must be >= 1", http.StatusBadRequest)
				return
			}

			settings := storage.ScheduleSettings{
				AutoFetchEnabled: req.AutoFetchEnabled,
				AutoFetchMinutes: req.AutoFetchMinutes,
				AutoCheckEnabled: req.AutoCheckEnabled,
				AutoCheckMinutes: req.AutoCheckMinutes,
			}
			if err := dbStore.UpsertScheduleSettings(settings); err != nil {
				writeError(w, err.Error(), http.StatusInternalServerError)
				return
			}
			if onUpdate != nil {
				onUpdate(settings)
			}
			_ = dbStore.AddActionLog("schedule_update", "success", "Schedule settings updated")
			writeJSON(w, map[string]string{"message": "Schedule settings saved"})

		default:
			writeError(w, "Method not allowed", http.StatusMethodNotAllowed)
		}
	}
}

func APIActionLogsHandler(dbStore *storage.SQLiteStore) http.HandlerFunc {
	return func(w http.ResponseWriter, r *http.Request) {
		if r.Method != http.MethodGet {
			writeError(w, "Method not allowed", http.StatusMethodNotAllowed)
			return
		}

		if dbStore == nil {
			writeError(w, "Database is not enabled", http.StatusServiceUnavailable)
			return
		}

		limit := 50
		if raw := r.URL.Query().Get("limit"); raw != "" {
			if parsed, err := strconv.Atoi(raw); err == nil && parsed > 0 {
				limit = parsed
			}
		}

		action := strings.TrimSpace(r.URL.Query().Get("action"))
		status := strings.TrimSpace(r.URL.Query().Get("status"))
		query := strings.TrimSpace(r.URL.Query().Get("q"))

		logs, err := dbStore.ListActionLogsFiltered(action, status, query, limit)
		if err != nil {
			writeError(w, err.Error(), http.StatusInternalServerError)
			return
		}

		payload := make([]ActionLogInfo, 0, len(logs))
		for _, logEntry := range logs {
			payload = append(payload, ActionLogInfo{
				ID:        logEntry.ID,
				Action:    logEntry.Action,
				Status:    logEntry.Status,
				Message:   logEntry.Message,
				CreatedAt: logEntry.CreatedAt.UTC().Format(time.RFC3339),
			})
		}

		writeJSON(w, payload)
	}
}

func RegisterConfigEndpoints(proxies []*models.ProxyConfig, proxyChecker *checker.ProxyChecker, startPort int) {
	endpoints := make([]EndpointInfo, 0, len(proxies))

	for _, proxy := range proxies {
		if proxy.StableID == "" {
			proxy.StableID = proxy.GenerateStableID()
		}

		endpoint := fmt.Sprintf("./config/%s", proxy.StableID)

		status, latency, _ := proxyChecker.GetProxyStatus(proxy.Name)

		endpoints = append(endpoints, EndpointInfo{
			Name:       proxy.Name,
			ServerInfo: fmt.Sprintf("%s:%d", proxy.Server, proxy.Port),
			URL:        endpoint,
			ProxyPort:  startPort + proxy.Index,
			Index:      proxy.Index,
			Status:     status,
			Latency:    latency,
			StableID:   proxy.StableID,
		})
	}

	endpointsMu.Lock()
	registeredEndpoints = endpoints
	endpointsMu.Unlock()
}

type PrefixServeMux struct {
	prefix string
	mux    *http.ServeMux
}

func NewPrefixServeMux(prefix string) (*PrefixServeMux, error) {
	if strings.HasSuffix(prefix, "/") {
		return nil, fmt.Errorf("served url path prefix '%s' should not ends with a '/'", prefix)
	}
	return &PrefixServeMux{
		prefix: prefix,
		mux:    http.NewServeMux(),
	}, nil
}

func (pm *PrefixServeMux) Handle(pattern string, handler http.Handler) {
	pm.mux.Handle(pm.prefix+pattern, http.StripPrefix(pm.prefix, handler))
}

func (pm *PrefixServeMux) ServeHTTP(w http.ResponseWriter, r *http.Request) {
	if r.URL.Path == pm.prefix || strings.HasPrefix(r.URL.Path, pm.prefix+"/") {
		pm.mux.ServeHTTP(w, r)
	} else {
		http.NotFound(w, r)
	}
}
