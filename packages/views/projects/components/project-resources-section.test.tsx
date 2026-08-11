import React from "react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { renderWithI18n } from "../../test/i18n";
import { ProjectResourcesSection } from "./project-resources-section";

const mocks = vi.hoisted(() => ({
  resources: [] as unknown[],
  currentMember: {
    userId: "user-1" as string | null,
    role: "member" as "owner" | "admin" | "member" | null,
    isLoading: false,
    isError: false,
  },
  runtimeMachines: [] as Array<{
    daemonId: string;
    title: string;
    subtitle: string | null;
    onlineCount: number;
    mode: "local";
    runtimes: Array<{ id: string; owner_id: string | null }>;
  }>,
  createResource: vi.fn(),
  updateResource: vi.fn(),
}));

vi.mock("@tanstack/react-query", () => ({
  useQuery: (options: { queryKey?: readonly unknown[] }) => {
    switch (options.queryKey?.[0]) {
      case "project-resources":
        return { data: mocks.resources, isLoading: false, isError: false };
      case "runtimes":
        return { data: [], isLoading: false, isError: false };
      default:
        return { data: [], isLoading: false, isError: false };
    }
  },
}));

vi.mock("@multica/core/projects", () => ({
  projectResourcesOptions: () => ({ queryKey: ["project-resources"] }),
  useCreateProjectResource: () => ({
    mutateAsync: mocks.createResource,
    isPending: false,
  }),
  useDeleteProjectResource: () => ({ mutateAsync: vi.fn() }),
  useUpdateProjectResource: () => ({
    mutateAsync: mocks.updateResource,
    isPending: false,
  }),
}));

vi.mock("@multica/core/permissions", () => ({
  useCurrentMember: () => mocks.currentMember,
}));

vi.mock("@multica/core/hooks", () => ({
  useWorkspaceId: () => "workspace-1",
}));

vi.mock("@multica/core/paths", () => ({
  useCurrentWorkspace: () => ({ repos: [] }),
}));

vi.mock("@multica/core/runtimes", () => ({
  runtimeListOptions: () => ({ queryKey: ["runtimes"] }),
}));

vi.mock("../../platform", () => ({
  isDesktopShell: () => false,
  pickDirectory: vi.fn(),
  validateLocalDirectory: vi.fn(),
  useLocalDaemonStatus: () => ({ daemonId: null, running: false }),
}));

vi.mock("../../runtimes/components/runtime-machines", () => ({
  buildRuntimeMachines: () => mocks.runtimeMachines,
}));

vi.mock("sonner", () => ({
  toast: { success: vi.fn(), error: vi.fn() },
}));

vi.mock("@multica/ui/components/ui/popover", () => ({
  Popover: ({ children }: { children: React.ReactNode }) => <>{children}</>,
  PopoverTrigger: ({ render }: { render: React.ReactNode }) => <>{render}</>,
  PopoverContent: ({ children }: { children: React.ReactNode }) => (
    <div>{children}</div>
  ),
}));

vi.mock("@multica/ui/components/ui/tooltip", () => ({
  Tooltip: ({ children }: { children: React.ReactNode }) => <>{children}</>,
  TooltipTrigger: ({ render }: { render: React.ReactNode }) => <>{render}</>,
  TooltipContent: ({ children }: { children: React.ReactNode }) => (
    <div role="tooltip">{children}</div>
  ),
}));

beforeEach(() => {
  mocks.resources = [];
  mocks.currentMember = {
    userId: "user-1",
    role: "member",
    isLoading: false,
    isError: false,
  };
  mocks.runtimeMachines = [
    {
      daemonId: "daemon-1",
      title: "Build PC",
      subtitle: "Windows",
      onlineCount: 1,
      mode: "local",
      runtimes: [{ id: "runtime-1", owner_id: "user-1" }],
    },
  ];
  mocks.createResource.mockReset();
  mocks.createResource.mockResolvedValue({});
  mocks.updateResource.mockReset();
  mocks.updateResource.mockResolvedValue({});
});

describe("ProjectResourcesSection", () => {
  it("binds a browser-entered absolute path to the selected runtime", async () => {
    const user = userEvent.setup();
    renderWithI18n(<ProjectResourcesSection projectId="project-1" />);

    await user.click(
      screen.getByRole("button", { name: "Add local directory" }),
    );
    await user.type(
      await screen.findByLabelText("Absolute path"),
      "C:\\Projects\\multica",
    );
    await user.click(
      screen.getByRole("button", { name: "Attach directory" }),
    );

    await waitFor(() => {
      expect(mocks.createResource).toHaveBeenCalledWith({
        resource_type: "local_directory",
        resource_ref: {
          local_path: "C:\\Projects\\multica",
          daemon_id: "daemon-1",
          runtime_id: "runtime-1",
          label: "multica",
        },
      });
    });
  });

  it("does not expose another member's local runtime as a path target", async () => {
    const user = userEvent.setup();
    mocks.runtimeMachines[0]!.runtimes = [
      { id: "runtime-foreign", owner_id: "user-2" },
    ];
    renderWithI18n(<ProjectResourcesSection projectId="project-1" />);

    await user.click(
      screen.getByRole("button", { name: "Add local directory" }),
    );

    expect(
      screen.getByText(
        "No local runtime you can manage is available in this workspace.",
      ),
    ).toBeInTheDocument();
    expect(
      screen.getByRole("button", { name: "Attach directory" }),
    ).toBeDisabled();
  });

  it("replaces an existing browser directory without removing the resource", async () => {
    const user = userEvent.setup();
    mocks.resources = [
      {
        id: "resource-1",
        resource_type: "local_directory",
        resource_ref: {
          daemon_id: "daemon-1",
          local_path: "C:\\Projects\\old-app",
          label: "old-app",
        },
        label: null,
      },
    ];
    renderWithI18n(<ProjectResourcesSection projectId="project-1" />);

    await user.click(screen.getByTitle("Change directory"));
    const path = await screen.findByLabelText("Absolute path");
    expect(path).toHaveValue("C:\\Projects\\old-app");
    await user.clear(path);
    await user.type(path, "C:\\Projects\\new-app");
    await user.click(screen.getByRole("button", { name: "Replace directory" }));

    await waitFor(() => {
      expect(mocks.updateResource).toHaveBeenCalledWith({
        resourceId: "resource-1",
        data: {
          resource_ref: {
            local_path: "C:\\Projects\\new-app",
            daemon_id: "daemon-1",
            runtime_id: "runtime-1",
            label: "new-app",
          },
        },
      });
    });
  });
});
