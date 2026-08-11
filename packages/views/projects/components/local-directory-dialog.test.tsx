import { screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { describe, expect, it, vi } from "vitest";
import { renderWithI18n } from "../../test/i18n";
import {
  isAbsoluteLocalPath,
  LocalDirectoryDialog,
  type LocalDirectoryMachine,
} from "./local-directory-dialog";

const MACHINES: LocalDirectoryMachine[] = [
  {
    runtimeId: "runtime-a",
    daemonId: "daemon-a",
    title: "Studio Mac",
    subtitle: "macOS",
    online: true,
  },
  {
    runtimeId: "runtime-b",
    daemonId: "daemon-b",
    title: "Build PC",
    subtitle: "Windows",
    online: false,
  },
];

function renderDialog(options: {
  machines?: LocalDirectoryMachine[];
  attachedDaemonIds?: ReadonlySet<string>;
  mode?: "attach" | "replace";
  initialDaemonId?: string;
  initialLocalPath?: string;
  loading?: boolean;
  loadFailed?: boolean;
  onSubmit?: (value: {
    runtimeId: string;
    daemonId: string;
    localPath: string;
    label: string;
  }) => Promise<boolean>;
} = {}) {
  const onOpenChange = vi.fn();
  const onSubmit = options.onSubmit ?? vi.fn().mockResolvedValue(true);
  renderWithI18n(
    <LocalDirectoryDialog
      open
      onOpenChange={onOpenChange}
      machines={options.machines ?? MACHINES}
      attachedDaemonIds={options.attachedDaemonIds ?? new Set()}
      mode={options.mode}
      initialDaemonId={options.initialDaemonId}
      initialLocalPath={options.initialLocalPath}
      loading={options.loading ?? false}
      loadFailed={options.loadFailed ?? false}
      submitting={false}
      onSubmit={onSubmit}
    />,
  );
  return { onOpenChange, onSubmit };
}

describe("isAbsoluteLocalPath", () => {
  it("accepts Windows, UNC, and POSIX paths", () => {
    expect(isAbsoluteLocalPath("/Users/mfbf/work")).toBe(true);
    expect(isAbsoluteLocalPath("C:\\Projects\\multica")).toBe(true);
    expect(isAbsoluteLocalPath("\\\\server\\share\\project")).toBe(true);
    expect(isAbsoluteLocalPath("projects/multica")).toBe(false);
  });
});

describe("LocalDirectoryDialog", () => {
  it("focuses the path field when the entered path is not absolute", async () => {
    const user = userEvent.setup();
    renderDialog();

    const input = screen.getByLabelText("Absolute path");
    await user.type(input, "projects/multica");
    await user.click(screen.getByRole("button", { name: "Attach directory" }));

    expect(screen.getByRole("alert")).toHaveTextContent("Enter an absolute path.");
    expect(input).toHaveFocus();
  });

  it("submits the selected runtime and derives a directory label", async () => {
    const user = userEvent.setup();
    const { onOpenChange, onSubmit } = renderDialog();

    const input = screen.getByLabelText("Absolute path");
    await user.type(input, "C:\\Projects\\multica");
    await user.click(screen.getByRole("button", { name: "Attach directory" }));

    await waitFor(() => {
      expect(onSubmit).toHaveBeenCalledWith({
        runtimeId: "runtime-a",
        daemonId: "daemon-a",
        localPath: "C:\\Projects\\multica",
        label: "multica",
      });
    });
    expect(onOpenChange).toHaveBeenCalledWith(false);
  });

  it("skips a machine that already has a directory bound to the project", async () => {
    const user = userEvent.setup();
    const { onSubmit } = renderDialog({
      attachedDaemonIds: new Set(["daemon-a"]),
    });

    await user.type(screen.getByLabelText("Absolute path"), "/srv/multica");
    await user.click(screen.getByRole("button", { name: "Attach directory" }));

    await waitFor(() => {
      expect(onSubmit).toHaveBeenCalledWith({
        runtimeId: "runtime-b",
        daemonId: "daemon-b",
        localPath: "/srv/multica",
        label: "multica",
      });
    });
  });

  it("prefills and replaces a directory on its existing machine", async () => {
    const user = userEvent.setup();
    const { onOpenChange, onSubmit } = renderDialog({
      mode: "replace",
      initialDaemonId: "daemon-a",
      initialLocalPath: "C:\\Projects\\old-app",
      attachedDaemonIds: new Set(["daemon-b"]),
    });

    const input = screen.getByLabelText("Absolute path");
    expect(input).toHaveValue("C:\\Projects\\old-app");
    await user.clear(input);
    await user.type(input, "C:\\Projects\\new-app");
    await user.click(screen.getByRole("button", { name: "Replace directory" }));

    await waitFor(() => {
      expect(onSubmit).toHaveBeenCalledWith({
        runtimeId: "runtime-a",
        daemonId: "daemon-a",
        localPath: "C:\\Projects\\new-app",
        label: "new-app",
      });
    });
    expect(onOpenChange).toHaveBeenCalledWith(false);
  });

  it("keeps submit disabled while runtime data is loading", () => {
    renderDialog({ loading: true });

    expect(screen.getByText("Loading local runtimes...")).toBeInTheDocument();
    expect(
      screen.getByRole("button", { name: "Attach directory" }),
    ).toBeDisabled();
  });
});
