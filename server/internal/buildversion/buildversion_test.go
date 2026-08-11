package buildversion

import (
	"errors"
	"reflect"
	"strings"
	"testing"
)

func TestResolveUsesTagDerivedGitDescribeVersion(t *testing.T) {
	var gotName string
	var gotArgs []string
	version, err := Resolve("", func(name string, args ...string) (string, error) {
		gotName = name
		gotArgs = append([]string(nil), args...)
		return "v0.4.20-3-gabcdef0-dirty\n", nil
	})
	if err != nil {
		t.Fatalf("Resolve() error = %v", err)
	}
	if version != "v0.4.20-3-gabcdef0-dirty" {
		t.Fatalf("Resolve() = %q", version)
	}
	if gotName != "git" {
		t.Fatalf("runner name = %q, want git", gotName)
	}
	wantArgs := []string{"describe", "--tags", "--match", "v[0-9]*", "--dirty"}
	if !reflect.DeepEqual(gotArgs, wantArgs) {
		t.Fatalf("runner args = %q, want %q", gotArgs, wantArgs)
	}
}

func TestResolveAcceptsSemverAndGitDescribeOverrides(t *testing.T) {
	for _, version := range []string{
		"v0.4.20",
		"0.4.20",
		"v0.4.20-dirty",
		"v1.0.0-rc.1",
		"v0.4.20-3-gabcdef0",
		"v0.4.20-3-gabcdef0-dirty",
	} {
		t.Run(version, func(t *testing.T) {
			got, err := Resolve(version, nil)
			if err != nil {
				t.Fatalf("Resolve(%q) error = %v", version, err)
			}
			if got != version {
				t.Fatalf("Resolve(%q) = %q", version, got)
			}
		})
	}
}

func TestResolveRejectsUntrustedVersions(t *testing.T) {
	for _, version := range []string{
		"dev",
		"0996b0a1-dirty",
		"0.0.0-gabcdef0",
		"v0.0.0-gabcdef0",
		"v0.4.20-",
	} {
		t.Run(version, func(t *testing.T) {
			_, err := Resolve(version, nil)
			if !errors.Is(err, ErrInvalidVersion) {
				t.Fatalf("Resolve(%q) error = %v, want ErrInvalidVersion", version, err)
			}
		})
	}
}

func TestResolveExplainsHowToRecoverWhenNoTagIsReachable(t *testing.T) {
	_, err := Resolve("", func(string, ...string) (string, error) {
		return "", errors.New("exit status 128")
	})
	if !errors.Is(err, ErrNoVersionTag) {
		t.Fatalf("Resolve() error = %v, want ErrNoVersionTag", err)
	}
	if !strings.Contains(err.Error(), "git fetch --tags") {
		t.Fatalf("Resolve() error = %q, want fetch-tags guidance", err)
	}
	if !strings.Contains(err.Error(), "MULTICA_CLI_BUILD_VERSION") {
		t.Fatalf("Resolve() error = %q, want override guidance", err)
	}
}

func TestResolveRejectsInvalidGitOutput(t *testing.T) {
	_, err := Resolve("", func(string, ...string) (string, error) {
		return "0996b0a1-dirty", nil
	})
	if !errors.Is(err, ErrInvalidVersion) {
		t.Fatalf("Resolve() error = %v, want ErrInvalidVersion", err)
	}
}
