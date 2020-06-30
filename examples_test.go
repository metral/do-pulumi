package examples

import (
	"fmt"
	"io/ioutil"
	"net/http"
	"os"
	"path"
	"strings"
	"testing"
	"time"

	"github.com/pulumi/pulumi/pkg/v2/testing/integration"
	"github.com/stretchr/testify/assert"
)

func TestDroplets(t *testing.T) {
	cwd, err := os.Getwd()
	if err != nil {
		t.FailNow()
	}

	test := getBaseOptions(t).
		With(integration.ProgramTestOptions{
			Dir: path.Join(cwd, "py-loadbalanced-droplets"),
			Config: map[string]string{
				"region": "nyc3",
			},
			ExtraRuntimeValidation: func(t *testing.T, stack integration.RuntimeValidationStackInfo) {
				endpoint := stack.Outputs["endpoint"].(string)
				maxWait := time.Minute * 10
				assertHTTPResultWithRetry(t, endpoint, nil, maxWait, func(body string) bool {
					return assert.Contains(t, body, "Welcome to nginx!")
				})
			},
		})
	integration.ProgramTest(t, &test)
}

func TestDOKS(t *testing.T) {
	cwd, err := os.Getwd()
	if err != nil {
		t.FailNow()
	}

	dir := path.Join(cwd, "ts-k8s", "step1")
	test := getBaseOptions(t).
		With(integration.ProgramTestOptions{
			Dir: dir,
			Config: map[string]string{
				"region":       "sfo3",
				"csrFilepath":  path.Join(dir, "certs", "devs.csr"),
				"keyFilepath":  path.Join(dir, "certs", "devs.key"),
				"certFilepath": path.Join(dir, "certs", "devs.crt"),
			},
			ExtraRuntimeValidation: func(t *testing.T, stack integration.RuntimeValidationStackInfo) {
				endpoint := stack.Outputs["instanceUrl"].(string)
				maxWait := time.Minute * 10
				assertHTTPResultWithRetry(t, endpoint, nil, maxWait, func(body string) bool {
					return assert.Contains(t, body, "Hello World")
				})
			},
		})
	integration.ProgramTest(t, &test)
}

func assertHTTPResult(t *testing.T, output interface{}, headers map[string]string, check func(string) bool) bool {
	return assertHTTPResultWithRetry(t, output, headers, 5*time.Minute, check)
}

func assertHTTPResultWithRetry(t *testing.T, output interface{}, headers map[string]string, maxWait time.Duration, check func(string) bool) bool {
	return assertHTTPResultShapeWithRetry(t, output, headers, maxWait, func(string) bool { return true }, check)
}

func assertHTTPResultShapeWithRetry(t *testing.T, output interface{}, headers map[string]string, maxWait time.Duration,
	ready func(string) bool, check func(string) bool) bool {
	hostname, ok := output.(string)
	if !assert.True(t, ok, fmt.Sprintf("expected `%s` output", output)) {
		return false
	}

	if !(strings.HasPrefix(hostname, "http://") || strings.HasPrefix(hostname, "https://")) {
		hostname = fmt.Sprintf("http://%s", hostname)
	}

	startTime := time.Now()
	count, sleep := 0, 0
	for true {
		now := time.Now()
		req, err := http.NewRequest("GET", hostname, nil)
		if !assert.NoError(t, err) {
			return false
		}

		for k, v := range headers {
			// Host header cannot be set via req.Header.Set(), and must be set
			// directly.
			if strings.ToLower(k) == "host" {
				req.Host = v
				continue
			}
			req.Header.Set(k, v)
		}

		client := &http.Client{Timeout: time.Second * 10}
		resp, err := client.Do(req)
		if err == nil && resp.StatusCode == 200 {
			if !assert.NotNil(t, resp.Body, "resp.body was nil") {
				return false
			}

			// Read the body
			defer resp.Body.Close()
			body, err := ioutil.ReadAll(resp.Body)
			if !assert.NoError(t, err) {
				return false
			}

			bodyText := string(body)

			// Even if we got 200 and a response, it may not be ready for assertion yet - that's specific per test.
			if ready(bodyText) {
				// Verify it matches expectations
				return check(bodyText)
			}
		}
		if now.Sub(startTime) >= maxWait {
			fmt.Printf("Timeout after %v. Unable to http.get %v successfully.", maxWait, hostname)
			return false
		}
		count++
		// delay 10s, 20s, then 30s and stay at 30s
		if sleep > 30 {
			sleep = 30
		} else {
			sleep += 10
		}
		time.Sleep(time.Duration(sleep) * time.Second)
		fmt.Printf("Http Error: %v\n", err)
		fmt.Printf("  Retry: %v, elapsed wait: %v, max wait %v\n", count, now.Sub(startTime), maxWait)
	}

	return false
}

func getAccessToken(t *testing.T) string {
	token := os.Getenv("DIGITALOCEAN_TOKEN")
	if token == "" {
		t.Skipf("Skipping test due to missing DIGITALOCEAN_TOKEN environment variable")
	}

	return token
}

func getBaseOptions(t *testing.T) integration.ProgramTestOptions {
	return integration.ProgramTestOptions{
		ExpectRefreshChanges: true,
		Quick:                true,
		SkipRefresh:          true,
		RetryFailedSteps:     true,
		Secrets: map[string]string{
			"digitalocean:token": getAccessToken(t),
		},
	}
}
