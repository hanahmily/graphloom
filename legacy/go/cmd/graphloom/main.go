// Command graphloom is the CLI entry for run, inspect, stop, and resume.
package main

import (
	"context"
	"fmt"
	"os"

	"github.com/hanahmily/graphloom/internal/controller"
)

func main() {
	if err := run(os.Args[1:]); err != nil {
		fmt.Fprintf(os.Stderr, "graphloom: %v\n", err)
		os.Exit(1)
	}
}

func run(args []string) error {
	if len(args) < 1 {
		return fmt.Errorf("usage: graphloom <run|inspect|stop|resume> ...")
	}
	ctx := context.Background()
	switch args[0] {
	case "run":
		if len(args) != 2 {
			return fmt.Errorf("usage: graphloom run <task.yaml>")
		}
		_, err := controller.Run(ctx, args[1])
		return err
	case "inspect":
		if len(args) != 2 {
			return fmt.Errorf("usage: graphloom inspect <run-id>")
		}
		_, err := controller.Inspect(ctx, args[1])
		return err
	case "stop":
		if len(args) != 2 {
			return fmt.Errorf("usage: graphloom stop <run-id>")
		}
		return controller.Stop(ctx, args[1])
	case "resume":
		if len(args) != 2 {
			return fmt.Errorf("usage: graphloom resume <run-id>")
		}
		_, err := controller.Resume(ctx, args[1])
		return err
	default:
		return fmt.Errorf("unknown command %q", args[0])
	}
}
