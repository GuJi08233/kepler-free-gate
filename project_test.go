package main

import "testing"

func TestKeplerRoutes(t *testing.T) {
	project := currentProject()
	for _, raw := range []string{"/v1/models", "/v1/chat/completions"} {
		if _, ok := normalizePath(project, raw); !ok {
			t.Fatalf("expected route %s to be accepted", raw)
		}
	}
	if _, ok := normalizePath(project, "/openai/v1/chat/completions"); ok {
		t.Fatal("Kepler must keep its direct /v1 routes")
	}
	if !project.gatewayAuth || !project.directFallback {
		t.Fatal("Kepler must preserve authentication and direct fallback")
	}
}
