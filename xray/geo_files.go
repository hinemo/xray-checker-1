package xray

import (
	"fmt"
	"io"
	"net/http"
	"os"
	"path/filepath"
	"time"

	"xray-checker/logger"
)

const (
	geoSiteURL  = "https://github.com/v2fly/domain-list-community/releases/latest/download/dlc.dat"
	geoSiteFile = "geo/geosite.dat"
	geoIPFile   = "geo/geoip.dat"
)

var geoIPURLs = []string{
	"https://github.com/v2fly/geoip/releases/latest/download/geoip.dat",
	"https://raw.githubusercontent.com/Loyalsoldier/geoip/release/geoip.dat",
	"https://cdn.jsdelivr.net/gh/Loyalsoldier/geoip@release/geoip.dat",
}

type GeoFileManager struct {
	baseDir string
}

func NewGeoFileManager(baseDir string) *GeoFileManager {
	if baseDir == "" {
		if wd, err := os.Getwd(); err == nil {
			baseDir = wd
		} else {
			baseDir = "."
		}
	}

	return &GeoFileManager{
		baseDir: baseDir,
	}
}

func (gfm *GeoFileManager) EnsureGeoFiles() error {
	if err := gfm.ensureFile(geoSiteFile, geoSiteURL); err != nil {
		return fmt.Errorf("failed to ensure geosite.dat: %v", err)
	}

	if err := gfm.ensureFileWithFallback(geoIPFile, geoIPURLs); err != nil {
		return fmt.Errorf("failed to ensure geoip.dat: %v", err)
	}

	return nil
}

func (gfm *GeoFileManager) ensureFile(filename, url string) error {
	filePath := filepath.Join(gfm.baseDir, filename)

	if _, err := os.Stat(filePath); err == nil {
		return nil
	}

	logger.Info("Downloading %s...", filename)

	fileDir := filepath.Dir(filePath)
	if err := os.MkdirAll(fileDir, 0755); err != nil {
		return fmt.Errorf("failed to create directory: %v", err)
	}

	if err := gfm.downloadFile(url, filePath); err != nil {
		return fmt.Errorf("failed to download %s: %v", filename, err)
	}

	logger.Info("Downloaded %s", filename)
	return nil
}

func (gfm *GeoFileManager) ensureFileWithFallback(filename string, urls []string) error {
	filePath := filepath.Join(gfm.baseDir, filename)

	if _, err := os.Stat(filePath); err == nil {
		return nil
	}

	logger.Info("Downloading %s...", filename)

	fileDir := filepath.Dir(filePath)
	if err := os.MkdirAll(fileDir, 0755); err != nil {
		return fmt.Errorf("failed to create directory: %v", err)
	}

	var lastErr error
	for _, url := range urls {
		if err := gfm.downloadFile(url, filePath); err != nil {
			lastErr = err
			logger.Warn("Download failed from %s: %v", url, err)
			continue
		}
		logger.Info("Downloaded %s", filename)
		return nil
	}

	if lastErr != nil {
		return fmt.Errorf("failed to download %s: %v", filename, lastErr)
	}
	return fmt.Errorf("failed to download %s: no URLs provided", filename)
}

func (gfm *GeoFileManager) downloadFile(url, filePath string) error {
	client := &http.Client{Timeout: 30 * time.Second}
	resp, err := client.Get(url)
	if err != nil {
		return fmt.Errorf("HTTP request failed: %v", err)
	}
	defer resp.Body.Close()

	if resp.StatusCode != http.StatusOK {
		return fmt.Errorf("HTTP request failed with status: %d", resp.StatusCode)
	}

	tmpPath := filePath + ".tmp"
	file, err := os.Create(tmpPath)
	if err != nil {
		return fmt.Errorf("failed to create file: %v", err)
	}
	defer func() {
		_ = file.Close()
	}()

	_, err = io.Copy(file, resp.Body)
	if err != nil {
		_ = os.Remove(tmpPath)
		return fmt.Errorf("failed to write file: %v", err)
	}

	if err := file.Close(); err != nil {
		_ = os.Remove(tmpPath)
		return fmt.Errorf("failed to close file: %v", err)
	}

	if err := os.Rename(tmpPath, filePath); err != nil {
		_ = os.Remove(tmpPath)
		return fmt.Errorf("failed to move file into place: %v", err)
	}

	return nil
}
