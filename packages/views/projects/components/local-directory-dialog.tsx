"use client";

import {
  type FormEvent,
  useEffect,
  useMemo,
  useRef,
  useState,
} from "react";
import { Monitor } from "lucide-react";
import {
  Dialog,
  DialogContent,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@multica/ui/components/ui/dialog";
import { Button } from "@multica/ui/components/ui/button";
import { Input } from "@multica/ui/components/ui/input";
import { Label } from "@multica/ui/components/ui/label";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@multica/ui/components/ui/select";
import { useT } from "../../i18n";

export interface LocalDirectoryMachine {
  runtimeId: string;
  daemonId: string;
  title: string;
  subtitle: string | null;
  online: boolean;
}

export interface LocalDirectoryDialogValue {
  runtimeId: string;
  daemonId: string;
  localPath: string;
  label: string;
}

export function LocalDirectoryDialog({
  open,
  onOpenChange,
  machines,
  attachedDaemonIds,
  mode = "attach",
  initialDaemonId,
  initialLocalPath = "",
  loading,
  loadFailed,
  submitting,
  onSubmit,
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  machines: LocalDirectoryMachine[];
  attachedDaemonIds: ReadonlySet<string>;
  mode?: "attach" | "replace";
  initialDaemonId?: string;
  initialLocalPath?: string;
  loading: boolean;
  loadFailed: boolean;
  submitting: boolean;
  onSubmit: (value: LocalDirectoryDialogValue) => Promise<boolean>;
}) {
  const { t } = useT("projects");
  const [runtimeId, setRuntimeId] = useState("");
  const [localPath, setLocalPath] = useState("");
  const [pathError, setPathError] = useState<string | null>(null);
  const pathInputRef = useRef<HTMLInputElement>(null);

  const availableMachines = useMemo(
    () => machines.filter((machine) => !attachedDaemonIds.has(machine.daemonId)),
    [attachedDaemonIds, machines],
  );
  const selectedMachine = machines.find((machine) => machine.runtimeId === runtimeId);

  useEffect(() => {
    if (!open) return;
    setLocalPath(initialLocalPath);
    setPathError(null);
  }, [initialLocalPath, open]);

  useEffect(() => {
    if (!open) return;
    setRuntimeId((current) =>
      (initialDaemonId
        ? availableMachines.find(
            (machine) => machine.daemonId === initialDaemonId,
          )?.runtimeId
        : undefined) ??
      (availableMachines.some((machine) => machine.runtimeId === current)
        ? current
        : availableMachines[0]?.runtimeId ?? ""),
    );
  }, [availableMachines, initialDaemonId, open]);

  const handleSubmit = async (event?: FormEvent<HTMLFormElement>) => {
    event?.preventDefault();
    const path = localPath.trim();
    if (!isAbsoluteLocalPath(path)) {
      setPathError(t(($) => $.resources.local_dialog.path_error_absolute));
      pathInputRef.current?.focus();
      return;
    }
    if (
      !selectedMachine ||
      !availableMachines.some(
        (machine) => machine.runtimeId === selectedMachine.runtimeId,
      )
    ) {
      return;
    }

    const attached = await onSubmit({
      runtimeId: selectedMachine.runtimeId,
      daemonId: selectedMachine.daemonId,
      localPath: path,
      label: localPathLabel(path),
    });
    if (attached) onOpenChange(false);
  };

  const noMachines = machines.length === 0;
  const noAvailableMachines = !noMachines && availableMachines.length === 0;

  return (
    <Dialog
      open={open}
      onOpenChange={(next) => {
        if (!submitting) onOpenChange(next);
      }}
    >
      <DialogContent className="gap-5 sm:max-w-md" showCloseButton={!submitting}>
        <form className="contents" onSubmit={(event) => void handleSubmit(event)}>
          <DialogHeader>
            <DialogTitle>
              {mode === "replace"
                ? t(($) => $.resources.local_dialog.replace_title)
                : t(($) => $.resources.local_dialog.title)}
            </DialogTitle>
          </DialogHeader>

        {loading ? (
          <p className="text-body text-muted-foreground">
            {t(($) => $.resources.local_dialog.loading_runtimes)}
          </p>
        ) : loadFailed ? (
          <p className="text-body text-muted-foreground">
            {t(($) => $.resources.local_dialog.load_runtimes_failed)}
          </p>
        ) : noMachines ? (
          <p className="text-body text-muted-foreground">
            {t(($) => $.resources.local_dialog.no_runtimes)}
          </p>
        ) : noAvailableMachines ? (
          <p className="text-body text-muted-foreground">
            {t(($) => $.resources.local_dialog.no_available_runtimes)}
          </p>
        ) : (
          <div className="space-y-4">
            <div className="space-y-1.5">
              <Label htmlFor="project-local-directory-runtime">
                {t(($) => $.resources.local_dialog.runtime_label)}
              </Label>
              <Select
                items={machines.map((machine) => ({
                  value: machine.runtimeId,
                  label: machine.title,
                }))}
                value={runtimeId}
                onValueChange={(value) => {
                  const machine = machines.find(
                    (candidate) => candidate.runtimeId === value,
                  );
                  if (machine && !attachedDaemonIds.has(machine.daemonId)) {
                    setRuntimeId(machine.runtimeId);
                  }
                }}
              >
                <SelectTrigger
                  id="project-local-directory-runtime"
                  className="w-full"
                >
                  <SelectValue
                    placeholder={t(($) => $.resources.local_dialog.runtime_placeholder)}
                  >
                    {selectedMachine ? (
                      <MachineLabel machine={selectedMachine} compact />
                    ) : null}
                  </SelectValue>
                </SelectTrigger>
                <SelectContent align="start" className="max-h-72">
                  {machines.map((machine) => {
                    const attached = attachedDaemonIds.has(machine.daemonId);
                    return (
                      <SelectItem
                        key={machine.runtimeId}
                        value={machine.runtimeId}
                        disabled={attached}
                      >
                        <MachineLabel machine={machine} />
                        {attached && (
                          <span className="ml-auto shrink-0 text-micro text-muted-foreground">
                            {t(($) => $.resources.local_dialog.runtime_configured)}
                          </span>
                        )}
                      </SelectItem>
                    );
                  })}
                </SelectContent>
              </Select>
            </div>

            <div className="space-y-1.5">
              <Label htmlFor="project-local-directory-path">
                {t(($) => $.resources.local_dialog.path_label)}
              </Label>
              <Input
                id="project-local-directory-path"
                ref={pathInputRef}
                name="local_path"
                autoComplete="off"
                autoFocus
                value={localPath}
                aria-invalid={pathError ? true : undefined}
                placeholder={t(($) => $.resources.local_dialog.path_placeholder)}
                onChange={(event) => {
                  setLocalPath(event.target.value);
                  if (pathError) setPathError(null);
                }}
              />
              {pathError && (
                <p role="alert" className="text-caption text-destructive">
                  {pathError}
                </p>
              )}
            </div>
          </div>
        )}

        <DialogFooter>
          <Button
            type="button"
            variant="outline"
            disabled={submitting}
            onClick={() => onOpenChange(false)}
          >
            {t(($) => $.resources.local_dialog.cancel)}
          </Button>
          <Button
            type="submit"
            disabled={
              submitting ||
              loading ||
              loadFailed ||
              noMachines ||
              noAvailableMachines ||
              !runtimeId ||
              !localPath.trim()
            }
          >
            {submitting
              ? mode === "replace"
                ? t(($) => $.resources.local_dialog.replacing)
                : t(($) => $.resources.local_dialog.submitting)
              : mode === "replace"
                ? t(($) => $.resources.local_dialog.replace_submit)
                : t(($) => $.resources.local_dialog.submit)}
          </Button>
        </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  );
}

function MachineLabel({
  machine,
  compact = false,
}: {
  machine: LocalDirectoryMachine;
  compact?: boolean;
}) {
  const { t } = useT("projects");
  return (
    <span className="flex min-w-0 flex-1 items-center gap-2">
      <Monitor className="size-3.5 shrink-0 text-muted-foreground" />
      <span className="min-w-0 flex-1 truncate">{machine.title}</span>
      {!compact && machine.subtitle && (
        <span className="shrink-0 text-caption text-muted-foreground">
          {machine.subtitle}
        </span>
      )}
      <span
        role="img"
        className={`h-1.5 w-1.5 shrink-0 rounded-full ${
          machine.online ? "bg-success" : "bg-muted-foreground/40"
        }`}
        aria-label={
          machine.online
            ? t(($) => $.resources.local_dialog.runtime_online)
            : t(($) => $.resources.local_dialog.runtime_offline)
        }
      />
    </span>
  );
}

export function isAbsoluteLocalPath(path: string): boolean {
  return (
    path.startsWith("/") ||
    path.startsWith("\\\\") ||
    /^[a-zA-Z]:[\\/]/.test(path)
  );
}

function localPathLabel(path: string): string {
  const trimmed = path.replace(/[\\/]+$/, "");
  const segment = trimmed.split(/[\\/]/).filter(Boolean).at(-1);
  return segment || path;
}
