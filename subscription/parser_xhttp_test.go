package subscription

import (
	"encoding/json"
	"testing"
)

func TestParseShareLink_XHTTPMode(t *testing.T) {
	p := NewParser()
	data := p.parseShareLink("vless://123e4567-e89b-12d3-a456-426614174000@example.com:443?type=xhttp&security=tls&path=%2Fconnect&host=edge.example.com&mode=packet-up#demo")
	if data == nil {
		t.Fatal("expected parsed link, got nil")
	}

	if data.Type != "xhttp" {
		t.Fatalf("expected type xhttp, got %q", data.Type)
	}
	if data.Mode != "packet-up" {
		t.Fatalf("expected mode packet-up, got %q", data.Mode)
	}
	if data.Path != "/connect" {
		t.Fatalf("expected path /connect, got %q", data.Path)
	}
}

func TestConvertOutbound_UsesOriginalXHTTPFallback(t *testing.T) {
	p := NewParser()

	outbound := map[string]any{
		"protocol": "vless",
		"tag":      "demo",
		"settings": map[string]any{
			"vnext": []map[string]any{
				{
					"address": "example.com",
					"port":    443,
					"users": []map[string]any{
						{
							"id": "123e4567-e89b-12d3-a456-426614174000",
						},
					},
				},
			},
		},
	}

	raw, err := json.Marshal(outbound)
	if err != nil {
		t.Fatalf("marshal outbound: %v", err)
	}

	originalData := map[string]*originalLinkData{
		"example.com:443": {
			Type: "xhttp",
			Path: "/connect",
			Host: "edge.example.com",
			Mode: "packet-up",
		},
	}

	cfg, err := p.convertOutbound(raw, 0, originalData)
	if err != nil {
		t.Fatalf("convertOutbound returned error: %v", err)
	}

	if cfg.Type != "xhttp" {
		t.Fatalf("expected type xhttp, got %q", cfg.Type)
	}
	if cfg.Mode != "packet-up" {
		t.Fatalf("expected mode packet-up, got %q", cfg.Mode)
	}
	if cfg.RawXhttpSettings == "" {
		t.Fatal("expected RawXhttpSettings to be populated")
	}
}
