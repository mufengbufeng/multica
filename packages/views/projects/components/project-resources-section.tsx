"use client";

import { useMemo, useState } from "react";
import { useQuery } from "@tanstack/react-query";
import {
  ChevronRight,
  FolderGit,
  FolderOpen,
  FolderPen,
  Monitor,
  Pencil,
  Plus,
  Search,
  Trash2,
} from "lucide-react";
import { toast } from "sonner";
import {
  projectResourcesOptions,
  useCreateProjectResource,
  useDeleteProjectResource,
  useUpdateProjectResource,
} from "@multica/core/projects";
import { useWorkspaceId } from "@multica/core/hooks";
import { useCurrentWorkspace } from "@multica/core/paths";
import { useCurrentMember } from "@multica/core/permissions";
import { runtimeListOptions } from "@multica/core/runtimes";
import type {
  AgentRuntime,
  GithubRepoResourceRef,
  LocalDirectoryResourceRef,
  ProjectResource,
} from "@multica/core/types";
import { Button } from "@multica/ui/components/ui/button";
import {
  Popover,
  PopoverContent,
  PopoverTrigger,
} from "@multica/ui/components/ui/popover";
import {
  Tooltip,
  TooltipTrigger,
  TooltipContent,
} from "@multica/ui/components/ui/tooltip";
import {
  isDesktopShell,
  pickDirectory,
  useLocalDaemonStatus,
  validateLocalDirectory,
  type ValidateLocalDirectoryResult,
} from "../../platform";
import { useT } from "../../i18n";
import { githubShortLabel } from "../../common/github-url";
import {
  LocalDirectoryDialog,
  type LocalDirectoryMachine,
  type LocalDirectoryDialogValue,
} from "./local-directory-dialog";
import { buildRuntimeMachines } from "../../runtimes/components/runtime-machines";

// Project Resources sidebar section.
//
// Type-dispatched at the row + add-flow level. Add a new resource_type by:
//   (1) extending the server validator
//   (2) extending ProjectResourceType in @multica/core/types
//   (3) adding a render case in ResourceRow and an add-control here
function isGithubRef(r: ProjectResource): r is ProjectResource & {
  resource_ref: GithubRepoResourceRef;
} {
  return r.resource_type === "github_repo";
}

function isLocalDirectoryRef(r: ProjectResource): r is ProjectResource & {
  resource_ref: LocalDirectoryResourceRef;
} {
  return r.resource_type === "local_directory";
}

type LocalDirectoryProjectResource = ProjectResource & {
  resource_ref: LocalDirectoryResourceRef;
};

export function ProjectResourcesSection({ projectId }: { projectId: string }) {
  const { t } = useT("projects");
  const wsId = useWorkspaceId();
  const workspace = useCurrentWorkspace();
  const currentMember = useCurrentMember(wsId);
  const currentUserId = currentMember.userId ?? undefined;
  const daemonStatus = useLocalDaemonStatus();
  const desktopMode = isDesktopShell();
  const [open, setOpen] = useState(true);
  const [addOpen, setAddOpen] = useState(false);
  const [localDialogOpen, setLocalDialogOpen] = useState(false);
  const [replacementResource, setReplacementResource] =
    useState<LocalDirectoryProjectResource | null>(null);
  const [repoSearch, setRepoSearch] = useState("");
  const [picking, setPicking] = useState(false);

  const { data: resources = [] } = useQuery(
    projectResourcesOptions(wsId, projectId),
  );
  const {
    data: runtimes = [],
    isLoading: runtimesLoading,
    isError: runtimesLoadFailed,
  } = useQuery(runtimeListOptions(wsId));
  const createResource = useCreateProjectResource(wsId, projectId);
  const updateResource = useUpdateProjectResource(wsId, projectId);
  const deleteResource = useDeleteProjectResource(wsId, projectId);

  const localDaemonId = daemonStatus.daemonId;

  const attachedUrls = new Set(
    resources.filter(isGithubRef).map((r) => r.resource_ref.url),
  );
  const attachedLocalPaths = new Set(
    resources
      .filter(isLocalDirectoryRef)
      .filter((r) => r.resource_ref.daemon_id === localDaemonId)
      .map((r) => r.resource_ref.local_path),
  );
  const attachedLocalDaemonIds = useMemo(
    () =>
      new Set(
        resources
          .filter(isLocalDirectoryRef)
          .map((resource) => resource.resource_ref.daemon_id),
      ),
    [resources],
  );
  const isWorkspaceAdmin =
    currentMember.role === "owner" || currentMember.role === "admin";
  const localRuntimeMachines = useMemo(
    () =>
      buildRuntimeMachines(
        runtimes.filter(
          (runtime) =>
            runtime.runtime_mode === "local" && runtime.daemon_id !== null,
        ),
        { now: Date.now(), currentUserId },
      ).flatMap((machine) => {
        if (machine.mode !== "local" || !machine.daemonId) return [];
        return [
          {
            daemonId: machine.daemonId,
            title: machine.title,
            subtitle: machine.subtitle,
            online: machine.onlineCount > 0,
            runtimes: machine.runtimes,
          },
        ];
      }),
    [currentUserId, runtimes],
  );
  const localMachines = useMemo<LocalDirectoryMachine[]>(
    () =>
      localRuntimeMachines.flatMap((machine) => {
        const runtime = machine.runtimes.find((candidate) =>
          canManageLocalRuntime(candidate, currentUserId, isWorkspaceAdmin),
        );
        if (!runtime) return [];
        return [
          {
            runtimeId: runtime.id,
            daemonId: machine.daemonId,
            title: machine.title,
            subtitle: machine.subtitle,
            online: machine.online,
          },
        ];
      }),
    [currentUserId, isWorkspaceAdmin, localRuntimeMachines],
  );
  const localMachineByDaemonId = useMemo(
    () =>
      new Map(
        localRuntimeMachines.map((machine) => [
          machine.daemonId,
          {
            runtimeId: machine.runtimes[0]?.id ?? "",
            daemonId: machine.daemonId,
            title: machine.title,
            subtitle: machine.subtitle,
            online: machine.online,
          },
        ]),
      ),
    [localRuntimeMachines],
  );
  const localRuntimeId = localMachines.find(
    (machine) => machine.daemonId === localDaemonId,
  )?.runtimeId;
  const replacementAttachedDaemonIds = useMemo(() => {
    if (!replacementResource) return attachedLocalDaemonIds;
    const daemonIds = new Set(attachedLocalDaemonIds);
    daemonIds.delete(replacementResource.resource_ref.daemon_id);
    return daemonIds;
  }, [attachedLocalDaemonIds, replacementResource]);
  // Per (project, daemon) we allow at most one local_directory — the
  // daemon-side resolver picks the first match by daemon_id, so two rows
  // on the same daemon would silently route the agent into one of them.
  // The server enforces this at the API boundary; the UI mirrors the
  // restriction by hiding the "Add" affordance once a row exists for the
  // current daemon, otherwise users would only discover the limit on a
  // 409 toast.
  const hasLocalDirectoryForCurrentDaemon =
    localDaemonId !== null && attachedLocalDaemonIds.has(localDaemonId);

  const repoQuery = repoSearch.trim().toLowerCase();
  const filteredRepos =
    workspace?.repos?.filter((repo) => repo.url.toLowerCase().includes(repoQuery)) ?? [];

  const handleAttach = async (url: string) => {
    try {
      await createResource.mutateAsync({
        resource_type: "github_repo",
        resource_ref: { url },
      });
      toast.success(t(($) => $.resources.toast_attached));
    } catch (err) {
      const msg = err instanceof Error ? err.message : t(($) => $.resources.toast_attach_failed);
      toast.error(msg);
    }
  };

  const handleAttachLocalDirectory = async () => {
    if (picking) return;
    setPicking(true);
    try {
      if (!localDaemonId || !daemonStatus.running) {
        toast.error(t(($) => $.resources.toast_local_daemon_not_running));
        return;
      }
      // Race guard: the button gates on this already, but if the picker
      // is opened while a concurrent resource-create lands the user
      // would otherwise see a 409. Surface a clearer message instead.
      if (attachedLocalPaths.size > 0) {
        toast.error(t(($) => $.resources.toast_local_daemon_already_attached));
        return;
      }
      const picked = await pickDirectory();
      if (!picked.ok) {
        if (picked.reason && picked.reason !== "cancelled") {
          toast.error(
            picked.error ?? t(($) => $.resources.toast_local_pick_failed),
          );
        }
        return;
      }
      const path = picked.path ?? "";
      const fallbackLabel = picked.basename ?? path;
      if (attachedLocalPaths.has(path)) {
        toast.error(t(($) => $.resources.toast_local_already_attached));
        return;
      }
      const validation = await validateLocalDirectory(path);
      if (!validation.ok) {
        toast.error(
          localValidationMessage(validation, {
            not_absolute: t(($) => $.resources.local_validate_not_absolute),
            not_found: t(($) => $.resources.local_validate_not_found),
            not_a_directory: t(($) => $.resources.local_validate_not_a_directory),
            not_readable: t(($) => $.resources.local_validate_not_readable),
            not_writable: t(($) => $.resources.local_validate_not_writable),
            unsupported: t(($) => $.resources.local_validate_unsupported),
            fallback: t(($) => $.resources.toast_local_pick_failed),
          }),
        );
        return;
      }
      await createResource.mutateAsync({
        resource_type: "local_directory",
        resource_ref: {
          local_path: path,
          daemon_id: localDaemonId,
          ...(localRuntimeId ? { runtime_id: localRuntimeId } : {}),
          label: fallbackLabel,
        },
      });
      toast.success(t(($) => $.resources.toast_local_attached));
      setAddOpen(false);
    } catch (err) {
      const msg =
        err instanceof Error
          ? err.message
          : t(($) => $.resources.toast_local_pick_failed);
      toast.error(msg);
    } finally {
      setPicking(false);
    }
  };

  const handleReplaceLocalDirectory = async (
    resource: LocalDirectoryProjectResource,
  ) => {
    if (picking) return;
    setPicking(true);
    try {
      if (
        !localDaemonId ||
        !daemonStatus.running ||
        resource.resource_ref.daemon_id !== localDaemonId
      ) {
        toast.error(t(($) => $.resources.toast_local_daemon_not_running));
        return;
      }
      const picked = await pickDirectory();
      if (!picked.ok) {
        if (picked.reason && picked.reason !== "cancelled") {
          toast.error(
            picked.error ?? t(($) => $.resources.toast_local_pick_failed),
          );
        }
        return;
      }
      const path = picked.path ?? "";
      if (path === resource.resource_ref.local_path) return;
      const validation = await validateLocalDirectory(path);
      if (!validation.ok) {
        toast.error(
          localValidationMessage(validation, {
            not_absolute: t(($) => $.resources.local_validate_not_absolute),
            not_found: t(($) => $.resources.local_validate_not_found),
            not_a_directory: t(($) => $.resources.local_validate_not_a_directory),
            not_readable: t(($) => $.resources.local_validate_not_readable),
            not_writable: t(($) => $.resources.local_validate_not_writable),
            unsupported: t(($) => $.resources.local_validate_unsupported),
            fallback: t(($) => $.resources.toast_local_pick_failed),
          }),
        );
        return;
      }
      await updateResource.mutateAsync({
        resourceId: resource.id,
        data: {
          resource_ref: {
            local_path: path,
            daemon_id: resource.resource_ref.daemon_id,
            ...(localRuntimeId ? { runtime_id: localRuntimeId } : {}),
            label: picked.basename ?? path,
          },
        },
      });
      toast.success(t(($) => $.resources.toast_local_replaced));
    } catch (err) {
      toast.error(
        err instanceof Error && err.message
          ? err.message
          : t(($) => $.resources.toast_local_replace_failed),
      );
    } finally {
      setPicking(false);
    }
  };

  const handleAttachBrowserLocalDirectory = async ({
    runtimeId,
    daemonId,
    localPath,
    label,
  }: LocalDirectoryDialogValue): Promise<boolean> => {
    if (attachedLocalDaemonIds.has(daemonId)) {
      toast.error(t(($) => $.resources.toast_local_daemon_already_attached));
      return false;
    }
    try {
      await createResource.mutateAsync({
        resource_type: "local_directory",
        resource_ref: {
          local_path: localPath,
          daemon_id: daemonId,
          runtime_id: runtimeId,
          label,
        },
      });
      toast.success(t(($) => $.resources.toast_local_attached));
      return true;
    } catch (err) {
      toast.error(
        err instanceof Error && err.message
          ? err.message
          : t(($) => $.resources.toast_local_pick_failed),
      );
      return false;
    }
  };

  const handleReplaceBrowserLocalDirectory = async ({
    runtimeId,
    daemonId,
    localPath,
    label,
  }: LocalDirectoryDialogValue): Promise<boolean> => {
    if (!replacementResource) return false;
    if (
      daemonId !== replacementResource.resource_ref.daemon_id &&
      attachedLocalDaemonIds.has(daemonId)
    ) {
      toast.error(t(($) => $.resources.toast_local_daemon_already_attached));
      return false;
    }
    try {
      await updateResource.mutateAsync({
        resourceId: replacementResource.id,
        data: {
          resource_ref: {
            local_path: localPath,
            daemon_id: daemonId,
            runtime_id: runtimeId,
            label,
          },
        },
      });
      toast.success(t(($) => $.resources.toast_local_replaced));
      return true;
    } catch (err) {
      toast.error(
        err instanceof Error && err.message
          ? err.message
          : t(($) => $.resources.toast_local_replace_failed),
      );
      return false;
    }
  };

  const handleRemove = async (resource: ProjectResource) => {
    try {
      await deleteResource.mutateAsync(resource.id);
      toast.success(t(($) => $.resources.toast_removed));
    } catch (err) {
      toast.error(
        err instanceof Error && err.message
          ? err.message
          : t(($) => $.resources.toast_remove_failed),
      );
    }
  };

  const handleRenameLocalDirectory = async (
    resource: ProjectResource & { resource_ref: LocalDirectoryResourceRef },
    nextLabel: string,
  ) => {
    const trimmed = nextLabel.trim();
    const previous = resource.resource_ref.label ?? resource.label ?? "";
    if (trimmed === previous.trim()) return;
    try {
      await updateResource.mutateAsync({
        resourceId: resource.id,
        data: {
          resource_ref: {
            ...resource.resource_ref,
            label: trimmed,
          },
        },
      });
      toast.success(t(($) => $.resources.toast_local_renamed));
    } catch (err) {
      const msg =
        err instanceof Error
          ? err.message
          : t(($) => $.resources.toast_local_rename_failed);
      toast.error(msg);
    }
  };

  return (
    <div>
      <button
        type="button"
        className={`flex w-full items-center gap-1 rounded-md px-2 py-1 text-caption font-medium transition-colors mb-2 hover:bg-accent/70 ${open ? "" : "text-muted-foreground hover:text-foreground"}`}
        onClick={() => setOpen(!open)}
      >
        {t(($) => $.resources.section_header)}
        <ChevronRight
          className={`!size-3 shrink-0 stroke-[2.5] text-muted-foreground transition-transform ${open ? "rotate-90" : ""}`}
        />
      </button>
      {open && (
        <div className="pl-2 space-y-1.5">
          {resources.length === 0 && (
            <p className="text-caption text-muted-foreground">
              {t(($) => $.resources.empty)}
            </p>
          )}
          {resources.length > 0 && (
            <div className="max-h-64 space-y-1.5 overflow-y-auto pr-1">
              {resources.map((resource) => (
                <ResourceRow
                  key={resource.id}
                  resource={resource}
                  localDaemonId={localDaemonId}
                  canEdit={
                    desktopMode ||
                    (isLocalDirectoryRef(resource) &&
                      localMachines.some(
                        (machine) =>
                          machine.daemonId === resource.resource_ref.daemon_id,
                      ))
                  }
                  showLocalAvailability={desktopMode}
                  machine={localMachineByDaemonId.get(
                    isLocalDirectoryRef(resource)
                      ? resource.resource_ref.daemon_id
                      : "",
                  )}
                  onRemove={() => handleRemove(resource)}
                  onRenameLocalDirectory={handleRenameLocalDirectory}
                  onReplaceLocalDirectory={
                    desktopMode
                      ? handleReplaceLocalDirectory
                      : (localResource) => {
                          setReplacementResource(localResource);
                          setLocalDialogOpen(true);
                        }
                  }
                />
              ))}
            </div>
          )}
          <Popover
            open={addOpen}
            onOpenChange={(v) => {
              setAddOpen(v);
              if (!v) setRepoSearch("");
            }}
          >
            <PopoverTrigger
              render={
                <Button
                  variant="ghost"
                  size="sm"
                  className="h-7 px-2 text-caption text-muted-foreground hover:text-foreground"
                >
                  <Plus className="size-3" />
                  {t(($) => $.resources.add_button)}
                </Button>
              }
            />
            <PopoverContent align="start" className="w-72 p-2 space-y-2">
              <div className="text-caption font-medium text-muted-foreground">
                {t(($) => $.resources.popover_title)}
              </div>
              {workspace?.repos && workspace.repos.length > 0 && (
                <>
                  <div className="relative">
                    <Search className="pointer-events-none absolute left-2 top-1/2 size-3.5 -translate-y-1/2 text-muted-foreground" />
                    <input
                      type="text"
                      value={repoSearch}
                      onChange={(e) => setRepoSearch(e.target.value)}
                      aria-label={t(($) => $.resources.repos_search_placeholder)}
                      placeholder={t(($) => $.resources.repos_search_placeholder)}
                      className="h-8 w-full rounded-md border bg-transparent pl-7 pr-2 text-caption outline-none placeholder:text-muted-foreground focus-visible:ring-1 focus-visible:ring-ring"
                    />
                  </div>
                  <div className="max-h-48 space-y-1 overflow-y-auto">
                    {filteredRepos.length === 0 && repoQuery && (
                      <p className="py-2 text-center text-caption text-muted-foreground">
                        {t(($) => $.resources.repos_search_empty)}
                      </p>
                    )}
                    {filteredRepos.map((repo) => {
                      const isAttached = attachedUrls.has(repo.url);
                      const isDisabled = isAttached || createResource.isPending;
                      return (
                        // Use aria-disabled instead of the native `disabled` attribute so
                        // hover events still reach the tooltip trigger on attached rows
                        // (browsers suppress pointer events on disabled form controls).
                        <button
                          key={repo.url}
                          type="button"
                          aria-disabled={isDisabled}
                          onClick={async () => {
                            if (isDisabled) return;
                            await handleAttach(repo.url);
                            setAddOpen(false);
                          }}
                          className="flex w-full items-center gap-2 rounded-md px-2 py-1.5 text-caption text-left hover:bg-accent transition-colors aria-disabled:opacity-50 aria-disabled:cursor-not-allowed aria-disabled:hover:bg-transparent"
                        >
                          <FolderGit className="size-3.5" />
                          <Tooltip>
                            <TooltipTrigger
                              render={
                                <span className="truncate flex-1">{githubShortLabel(repo.url)}</span>
                              }
                            />
                            <TooltipContent side="top">{repo.url}</TooltipContent>
                          </Tooltip>
                          {isAttached && (
                            <span className="text-micro text-muted-foreground">
                              {t(($) => $.resources.attached_badge)}
                            </span>
                          )}
                        </button>
                      );
                    })}
                  </div>
                </>
              )}
              <CustomRepoForm
                onSubmit={async (url) => {
                  await handleAttach(url);
                  setAddOpen(false);
                }}
              />
            </PopoverContent>
          </Popover>
          {desktopMode ? (
            <div className="flex flex-col">
              <Button
                variant="ghost"
                size="sm"
                className="h-7 justify-start px-2 text-caption text-muted-foreground hover:text-foreground"
                disabled={
                  picking ||
                  createResource.isPending ||
                  !daemonStatus.running ||
                  hasLocalDirectoryForCurrentDaemon
                }
                onClick={() => {
                  void handleAttachLocalDirectory();
                }}
              >
                <FolderOpen className="size-3" />
                {t(($) => $.resources.add_local_directory_button)}
              </Button>
              {!daemonStatus.running && (
                <p className="px-2 pt-0.5 text-micro text-muted-foreground">
                  {t(($) => $.resources.local_daemon_offline_hint)}
                </p>
              )}
              {daemonStatus.running && hasLocalDirectoryForCurrentDaemon && (
                <p className="px-2 pt-0.5 text-micro text-muted-foreground">
                  {t(($) => $.resources.local_daemon_already_attached_hint)}
                </p>
              )}
            </div>
          ) : (
            <Button
              variant="ghost"
              size="sm"
              className="h-7 justify-start px-2 text-caption text-muted-foreground hover:text-foreground"
              disabled={createResource.isPending}
              onClick={() => {
                setReplacementResource(null);
                setLocalDialogOpen(true);
              }}
            >
              <FolderOpen className="size-3" />
              {t(($) => $.resources.add_local_directory_button)}
            </Button>
          )}
          <LocalDirectoryDialog
            open={localDialogOpen}
            onOpenChange={(next) => {
              setLocalDialogOpen(next);
              if (!next) setReplacementResource(null);
            }}
            machines={localMachines}
            attachedDaemonIds={replacementAttachedDaemonIds}
            mode={replacementResource ? "replace" : "attach"}
            initialDaemonId={replacementResource?.resource_ref.daemon_id}
            initialLocalPath={replacementResource?.resource_ref.local_path}
            loading={runtimesLoading || currentMember.isLoading}
            loadFailed={runtimesLoadFailed || currentMember.isError}
            submitting={createResource.isPending || updateResource.isPending}
            onSubmit={
              replacementResource
                ? handleReplaceBrowserLocalDirectory
                : handleAttachBrowserLocalDirectory
            }
          />
        </div>
      )}
    </div>
  );
}

function canManageLocalRuntime(
  runtime: AgentRuntime,
  currentUserId: string | undefined,
  isWorkspaceAdmin: boolean,
): boolean {
  return isWorkspaceAdmin || (!!currentUserId && runtime.owner_id === currentUserId);
}

interface ResourceRowProps {
  resource: ProjectResource;
  localDaemonId: string | null;
  canEdit: boolean;
  showLocalAvailability: boolean;
  machine: LocalDirectoryMachine | undefined;
  onRemove: () => void;
  onRenameLocalDirectory: (
    resource: LocalDirectoryProjectResource,
    nextLabel: string,
  ) => Promise<void>;
  onReplaceLocalDirectory: (resource: LocalDirectoryProjectResource) => void;
}

function ResourceRow({
  resource,
  localDaemonId,
  canEdit,
  showLocalAvailability,
  machine,
  onRemove,
  onRenameLocalDirectory,
  onReplaceLocalDirectory,
}: ResourceRowProps) {
  const { t } = useT("projects");
  if (isGithubRef(resource)) {
    const ref = resource.resource_ref;
    const display = resource.label || (ref.ref ? `${githubShortLabel(ref.url)} @ ${ref.ref}` : githubShortLabel(ref.url));
    const tooltip = ref.ref ? `${ref.url}\nref: ${ref.ref}` : ref.url;
    return (
      <div className="flex items-center gap-2 text-caption group">
        <FolderGit className="size-3.5 text-muted-foreground shrink-0" />
        <Tooltip>
          <TooltipTrigger
            render={
              <a
                href={ref.url}
                target="_blank"
                rel="noopener noreferrer"
                className="truncate flex-1 hover:underline"
              >
                {display}
              </a>
            }
          />
          <TooltipContent side="top" className="whitespace-pre-line">{tooltip}</TooltipContent>
        </Tooltip>
        <button
          type="button"
          onClick={onRemove}
          className="opacity-0 group-hover:opacity-100 transition-opacity rounded-sm p-0.5 hover:bg-accent"
          title={t(($) => $.resources.remove_tooltip)}
        >
          <Trash2 className="size-3 text-muted-foreground" />
        </button>
      </div>
    );
  }

  if (isLocalDirectoryRef(resource)) {
    return (
      <LocalDirectoryRow
        resource={resource}
        localDaemonId={localDaemonId}
        canEdit={canEdit}
        showLocalAvailability={showLocalAvailability}
        machine={machine}
        onRemove={onRemove}
        onRename={onRenameLocalDirectory}
        onReplace={onReplaceLocalDirectory}
      />
    );
  }

  return (
    <div className="flex items-center gap-2 text-caption text-muted-foreground">
      <span className="truncate flex-1">
        {resource.label || resource.resource_type}
      </span>
      <button
        type="button"
        onClick={onRemove}
        className="rounded-sm p-0.5 hover:bg-accent"
        title={t(($) => $.resources.remove_tooltip)}
      >
        <Trash2 className="size-3" />
      </button>
    </div>
  );
}

interface LocalDirectoryRowProps {
  resource: LocalDirectoryProjectResource;
  localDaemonId: string | null;
  canEdit: boolean;
  showLocalAvailability: boolean;
  machine: LocalDirectoryMachine | undefined;
  onRemove: () => void;
  onRename: (
    resource: LocalDirectoryProjectResource,
    nextLabel: string,
  ) => Promise<void>;
  onReplace: (resource: LocalDirectoryProjectResource) => void;
}

function LocalDirectoryRow({
  resource,
  localDaemonId,
  canEdit,
  showLocalAvailability,
  machine,
  onRemove,
  onRename,
  onReplace,
}: LocalDirectoryRowProps) {
  const { t } = useT("projects");
  const ref = resource.resource_ref;
  const display = (ref.label || resource.label || ref.local_path).trim() ||
    ref.local_path;
  const isForeignDaemon =
    showLocalAvailability &&
    localDaemonId !== null &&
    ref.daemon_id !== localDaemonId;
  const isLocalUnknown = showLocalAvailability && localDaemonId === null;
  // "disabled" in the spec sense — visual de-emphasis + no chat hint, and
  // edit actions are hidden on foreign / unknown-daemon rows because the label
  // and path belong to the owning device. Delete stays available so the user can
  // drop a stale registration from any device.
  const mismatch = isForeignDaemon || isLocalUnknown;

  const [editing, setEditing] = useState(false);
  const [draft, setDraft] = useState(display);

  const startEdit = () => {
    setDraft(display);
    setEditing(true);
  };
  const commit = async () => {
    setEditing(false);
    await onRename(resource, draft);
  };
  const cancel = () => {
    setEditing(false);
    setDraft(display);
  };

  return (
    <div
      className={`flex items-center gap-2 text-caption group ${
        mismatch ? "opacity-60" : ""
      }`}
    >
      <FolderOpen className="size-3.5 text-muted-foreground shrink-0" />
      {editing ? (
        <input
          autoFocus
          value={draft}
          onChange={(e) => setDraft(e.target.value)}
          onBlur={() => void commit()}
          onKeyDown={(e) => {
            if (e.key === "Enter") {
              e.preventDefault();
              void commit();
            } else if (e.key === "Escape") {
              e.preventDefault();
              cancel();
            }
          }}
          className="flex-1 min-w-0 rounded-sm border bg-transparent px-1 py-0.5 text-caption outline-none focus-visible:ring-1 focus-visible:ring-ring"
          aria-label={t(($) => $.resources.local_rename_label)}
        />
      ) : (
        <Tooltip>
          <TooltipTrigger
            render={
              <span className="min-w-0 flex-1">
                <span className="block truncate">{display}</span>
                {machine && (
                  <span className="mt-0.5 flex min-w-0 items-center gap-1 text-micro text-muted-foreground">
                    <Monitor className="size-2.5 shrink-0" />
                    <span className="truncate">{machine.title}</span>
                  </span>
                )}
              </span>
            }
          />
          <TooltipContent side="top">
            <div className="space-y-0.5 text-micro">
              <div className="font-mono">{ref.local_path}</div>
              {machine && <div>{machine.title}</div>}
              {mismatch && (
                <div className="text-muted-foreground">
                  {isLocalUnknown
                    ? t(($) => $.resources.local_no_daemon_tooltip)
                    : t(($) => $.resources.local_other_machine_tooltip)}
                </div>
              )}
            </div>
          </TooltipContent>
        </Tooltip>
      )}
      {canEdit && !mismatch && !editing && (
        <button
          type="button"
          onClick={() => onReplace(resource)}
          className="opacity-0 group-hover:opacity-100 transition-opacity rounded-sm p-0.5 hover:bg-accent"
          title={t(($) => $.resources.local_replace_tooltip)}
        >
          <FolderPen className="size-3 text-muted-foreground" />
        </button>
      )}
      {canEdit && !mismatch && !editing && (
        <button
          type="button"
          onClick={startEdit}
          className="opacity-0 group-hover:opacity-100 transition-opacity rounded-sm p-0.5 hover:bg-accent"
          title={t(($) => $.resources.local_rename_tooltip)}
        >
          <Pencil className="size-3 text-muted-foreground" />
        </button>
      )}
      <button
        type="button"
        onClick={onRemove}
        className="opacity-0 group-hover:opacity-100 transition-opacity rounded-sm p-0.5 hover:bg-accent"
        title={t(($) => $.resources.remove_tooltip)}
      >
        <Trash2 className="size-3 text-muted-foreground" />
      </button>
    </div>
  );
}

function CustomRepoForm({
  onSubmit,
}: {
  onSubmit: (url: string) => Promise<void> | void;
}) {
  const { t } = useT("projects");
  const [url, setUrl] = useState("");
  const [submitting, setSubmitting] = useState(false);
  const handle = async (e: React.FormEvent) => {
    e.preventDefault();
    const trimmed = url.trim();
    if (!trimmed) return;
    setSubmitting(true);
    try {
      await onSubmit(trimmed);
      setUrl("");
    } finally {
      setSubmitting(false);
    }
  };
  return (
    <form onSubmit={handle} className="flex items-center gap-1.5 pt-1 border-t">
      <input
        type="text"
        value={url}
        onChange={(e) => setUrl(e.target.value)}
        placeholder={t(($) => $.resources.url_placeholder)}
        className="flex-1 bg-transparent text-caption px-2 py-1 outline-none placeholder:text-muted-foreground"
      />
      <Button
        type="submit"
        size="sm"
        variant="ghost"
        className="h-6 px-2 text-caption"
        disabled={!url.trim() || submitting}
      >
        {t(($) => $.resources.url_submit)}
      </Button>
    </form>
  );
}

function localValidationMessage(
  result: ValidateLocalDirectoryResult,
  strings: {
    not_absolute: string;
    not_found: string;
    not_a_directory: string;
    not_readable: string;
    not_writable: string;
    unsupported: string;
    fallback: string;
  },
): string {
  switch (result.reason) {
    case "not_absolute":
      return strings.not_absolute;
    case "not_found":
      return strings.not_found;
    case "not_a_directory":
      return strings.not_a_directory;
    case "not_readable":
      return strings.not_readable;
    case "not_writable":
      return strings.not_writable;
    case "unsupported":
      return strings.unsupported;
    case "error":
    default:
      return result.error ?? strings.fallback;
  }
}
