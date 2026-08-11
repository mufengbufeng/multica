// Package buildversion resolves the version stamped into source-built CLI binaries.
package buildversion

import (
	"errors"
	"fmt"
	"os/exec"
	"regexp"
	"strings"
)

var (
	// ErrNoVersionTag indicates that the checkout has no reachable release tag
	// from which a trustworthy source-build version can be derived.
	ErrNoVersionTag = errors.New("no reachable semantic version tag")
	// ErrInvalidVersion indicates an override or git output that cannot safely
	// be used as a Multica CLI version.
	ErrInvalidVersion = errors.New("invalid Multica CLI build version")
)

// versionRE accepts release semver and git-describe output rooted at a semver
// tag. The prerelease portion deliberately allows the "-N-g<sha>" suffix
// emitted by git describe, including prerelease tags such as v1.2.3-rc.1.
var versionRE = regexp.MustCompile(`^v?(?:0|[1-9][0-9]*)\.(?:0|[1-9][0-9]*)\.(?:0|[1-9][0-9]*)(?:-[0-9A-Za-z][0-9A-Za-z.-]*)?(?:\+[0-9A-Za-z][0-9A-Za-z.-]*)?$`)

// desktopHashFallbackRE is the Electron package-version fallback used when
// git has no tag. It is valid npm semver but is not a traceable Multica CLI
// source-build version and would still fail the daemon capability gates.
var desktopHashFallbackRE = regexp.MustCompile(`^v?0\.0\.0-g[0-9a-fA-F]+$`)

// Runner runs a command and returns its stdout. It exists so resolution can be
// tested without a real Git repository.
type Runner func(name string, args ...string) (string, error)

// Resolve returns an explicitly supplied version or one derived from the
// nearest reachable vX.Y.Z tag. It intentionally does not use git describe
// --always: a bare commit hash must fail rather than masquerade as a supported
// daemon build.
func Resolve(override string, run Runner) (string, error) {
	version := strings.TrimSpace(override)
	if version == "" {
		if run == nil {
			return "", fmt.Errorf("%w: run `git fetch --tags` or set MULTICA_CLI_BUILD_VERSION", ErrNoVersionTag)
		}
		output, err := run("git", "describe", "--tags", "--match", "v[0-9]*", "--dirty")
		if err != nil {
			return "", fmt.Errorf("%w: run `git fetch --tags` or set MULTICA_CLI_BUILD_VERSION: %w", ErrNoVersionTag, err)
		}
		version = strings.TrimSpace(output)
		if version == "" {
			return "", fmt.Errorf("%w: git describe returned no version; run `git fetch --tags` or set MULTICA_CLI_BUILD_VERSION", ErrNoVersionTag)
		}
	}

	if !versionRE.MatchString(version) || desktopHashFallbackRE.MatchString(version) {
		return "", fmt.Errorf(
			"%w %q: use a vX.Y.Z tag-derived value or set MULTICA_CLI_BUILD_VERSION to one",
			ErrInvalidVersion,
			version,
		)
	}
	return version, nil
}

// RunGit executes Git without a shell so the v[0-9]* match pattern remains a
// single literal argument on every platform.
func RunGit(name string, args ...string) (string, error) {
	output, err := exec.Command(name, args...).Output()
	return string(output), err
}
