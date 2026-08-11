// buildversion prints the trusted version to stamp into a source-built CLI.
package main

import (
	"flag"
	"fmt"
	"os"

	"github.com/multica-ai/multica/server/internal/buildversion"
)

func main() {
	override := flag.String(
		"override",
		os.Getenv("MULTICA_CLI_BUILD_VERSION"),
		"explicit CLI build version (defaults to MULTICA_CLI_BUILD_VERSION)",
	)
	flag.Parse()
	if flag.NArg() != 0 {
		fmt.Fprintln(os.Stderr, "usage: buildversion [--override <version>]")
		os.Exit(2)
	}

	version, err := buildversion.Resolve(*override, buildversion.RunGit)
	if err != nil {
		fmt.Fprintln(os.Stderr, err)
		os.Exit(1)
	}
	fmt.Println(version)
}
