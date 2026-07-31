package main

import "net/http"

type modelMode int

const (
	modelPassthrough modelMode = iota
	modelKilo
	modelOpenCode
)

type projectSpec struct {
	name                  string
	displayName           string
	upstream              string
	probePath             string
	modelPath             string
	probeHeaders          http.Header
	forwardHeaders        []string
	prefixes              []string
	postPaths             map[string]struct{}
	gatewayAuth           bool
	upstreamAuthorization string
	defaultClientHeader   string
	directFallback        bool
	modelMode             modelMode
	ownedBy               string
	extraModels           []string
	specialModels         map[string]string
}

func currentProject() projectSpec {
	return projectSpec{
		name:        "kepler-free-gate",
		displayName: "Kepler AI",
		upstream:    "https://oai.endpoints.kepler.ai.cloud.ovh.net",
		probePath:   "/v1/models",
		modelPath:   "/v1/models",
		probeHeaders: http.Header{
			"Accept": []string{"application/json"},
		},
		forwardHeaders: []string{
			"content-type",
			"accept",
		},
		postPaths: map[string]struct{}{
			"/v1/chat/completions": {},
		},
		gatewayAuth:    true,
		directFallback: true,
		modelMode:      modelPassthrough,
		ownedBy:        "kepler",
	}
}
