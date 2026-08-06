"use client";

import { useEffect, useRef, useState, type FormEvent, type ReactNode } from "react";
import { useQueryClient } from "@tanstack/react-query";
import {
  Card,
  CardHeader,
  CardTitle,
  CardDescription,
  CardContent,
  CardFooter,
} from "@multica/ui/components/ui/card";
import { Input } from "@multica/ui/components/ui/input";
import { Button } from "@multica/ui/components/ui/button";
import { Label } from "@multica/ui/components/ui/label";
import { useAuthStore } from "@multica/core/auth";
import { useConfigStore } from "@multica/core/config";
import { workspaceKeys } from "@multica/core/workspace/queries";
import { api } from "@multica/core/api";
import type { User } from "@multica/core/types";
import { useT } from "../i18n";

interface CliCallbackConfig {
  /** Validated localhost callback URL. */
  url: string;
  /** Opaque state to pass back to CLI. */
  state: string;
}

interface LoginPageProps {
  /** Logo element rendered above the title. */
  logo?: ReactNode;
  /** Called after successful login. The workspace list is seeded into React
   * Query before this fires, so the caller can compute a destination URL. */
  onSuccess: () => void;
  /** CLI callback config for authorizing CLI tools. */
  cliCallback?: CliCallbackConfig;
  /** Called after a token is obtained (e.g. to set cookies). */
  onTokenObtained?: () => void;
  /** Slot rendered at the bottom of the card. */
  extra?: ReactNode;
}

export function redirectToCliCallback(url: string, token: string, state: string) {
  const separator = url.includes("?") ? "&" : "?";
  window.location.href = `${url}${separator}token=${encodeURIComponent(token)}&state=${encodeURIComponent(state)}`;
}

/**
 * Validate that a CLI callback URL points to a safe host over HTTP.
 * Allows localhost and private/LAN IPs (RFC 1918) to support self-hosted setups
 * on local VMs while blocking arbitrary public hosts.
 */
export function validateCliCallback(cliCallback: string): boolean {
  try {
    const cbUrl = new URL(cliCallback);
    if (cbUrl.protocol !== "http:") return false;
    const h = cbUrl.hostname;
    if (h === "localhost" || h === "127.0.0.1") return true;
    if (/^10\./.test(h)) return true;
    if (/^172\.(1[6-9]|2\d|3[01])\./.test(h)) return true;
    if (/^192\.168\./.test(h)) return true;
    return false;
  } catch {
    return false;
  }
}

export function LoginPage({
  logo,
  onSuccess,
  cliCallback,
  onTokenObtained,
  extra,
}: LoginPageProps) {
  const { t } = useT("auth");
  const qc = useQueryClient();
  const legacyAuthEnabled = useConfigStore((state) => state.legacyAuthEnabled);
  const [mode, setMode] = useState<"login" | "register" | "legacy">("login");
  const [legacyStep, setLegacyStep] = useState<"request" | "verify" | "enroll">("request");
  const [verificationCode, setVerificationCode] = useState("");
  const [step, setStep] = useState<"credentials" | "cli_confirm">("credentials");
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [error, setError] = useState("");
  const [loading, setLoading] = useState(false);
  const [existingUser, setExistingUser] = useState<User | null>(null);
  // Tracks how the existing session was detected so handleCliAuthorize
  // uses the matching token source (cookie -> issueCliToken, localStorage -> direct).
  const authSourceRef = useRef<"cookie" | "localStorage">("cookie");

  // Check for an existing session when the CLI asks for authorization.
  // Cookie auth is preferred so an old local token cannot authorize the wrong user.
  useEffect(() => {
    if (!cliCallback) return;

    api.setToken(null);
    api
      .getMe()
      .then((user) => {
        authSourceRef.current = "cookie";
        setExistingUser(user);
        setStep("cli_confirm");
      })
      .catch(() => {
        const token = localStorage.getItem("multica_token");
        if (!token) return;

        api.setToken(token);
        api
          .getMe()
          .then((user) => {
            authSourceRef.current = "localStorage";
            setExistingUser(user);
            setStep("cli_confirm");
          })
          .catch(() => {
            api.setToken(null);
            localStorage.removeItem("multica_token");
          });
      });
  }, [cliCallback]);

  const finishLogin = async () => {
    const workspaces = await api.listWorkspaces();
    qc.setQueryData(workspaceKeys.list(), workspaces);
    onTokenObtained?.();
    onSuccess();
  };

  const handleCredentials = async (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    if (!email) {
      setError(t(($) => $.common.email_required));
      return;
    }
    const needsPassword = mode !== "legacy" || legacyStep === "enroll";
    if (needsPassword && !password) {
      setError(t(($) => $.common.password_required));
      return;
    }
    if (mode === "legacy" && legacyStep === "verify" && !verificationCode) {
      setError(t(($) => $.legacy.code_required));
      return;
    }

    setLoading(true);
    setError("");
    try {
      if (mode === "legacy") {
        if (legacyStep === "request") {
          await api.sendCode(email);
          setLegacyStep("verify");
          return;
        }
        if (legacyStep === "verify") {
          const response = await api.verifyCode(email, verificationCode);
          useAuthStore.getState().completeLogin(response);
          setLegacyStep("enroll");
          setPassword("");
          return;
        }

        const response = await api.enrollPassword(password);
        useAuthStore.getState().completeLogin(response);
        await finishLogin();
        return;
      }

      if (cliCallback) {
        const { token } = mode === "register"
          ? await api.register(email, password)
          : await api.login(email, password);
        localStorage.setItem("multica_token", token);
        api.setToken(token);
        onTokenObtained?.();
        redirectToCliCallback(cliCallback.url, token, cliCallback.state);
        return;
      }

      if (mode === "register") {
        await useAuthStore.getState().register(email, password);
      } else {
        await useAuthStore.getState().login(email, password);
      }
      await finishLogin();
    } catch (err) {
      setError(err instanceof Error ? err.message : t(($) => $.errors.auth_failed));
    } finally {
      setLoading(false);
    }
  };

  const handleCliAuthorize = async () => {
    if (!cliCallback) return;
    setLoading(true);
    setError("");

    try {
      let token: string;
      if (authSourceRef.current === "localStorage") {
        const stored = localStorage.getItem("multica_token");
        if (!stored) throw new Error("token missing");
        token = stored;
      } else {
        token = (await api.issueCliToken()).token;
      }

      onTokenObtained?.();
      redirectToCliCallback(cliCallback.url, token, cliCallback.state);
    } catch {
      setError(t(($) => $.errors.cli_auth_failed));
      setExistingUser(null);
      setStep("credentials");
    } finally {
      setLoading(false);
    }
  };

  if (step === "cli_confirm" && existingUser) {
    return (
      <div className="flex min-h-svh items-center justify-center">
        <Card className="w-full max-w-sm">
          <CardHeader className="text-center">
            {logo && <div className="mx-auto mb-4">{logo}</div>}
            <CardTitle className="text-display-sm">{t(($) => $.cli.title)}</CardTitle>
            <CardDescription>
              {t(($) => $.cli.description, { email: existingUser.email })}
            </CardDescription>
          </CardHeader>
          <CardContent className="flex flex-col gap-3">
            <Button onClick={handleCliAuthorize} disabled={loading} className="w-full" size="lg">
              {loading ? t(($) => $.cli.authorizing) : t(($) => $.cli.authorize)}
            </Button>
            <Button
              variant="ghost"
              className="w-full"
              onClick={() => {
                setExistingUser(null);
                setStep("credentials");
              }}
            >
              {t(($) => $.cli.different_account)}
            </Button>
          </CardContent>
        </Card>
      </div>
    );
  }

  const isRegistering = mode === "register";
  const isLegacy = mode === "legacy";
  const title = isLegacy
    ? t(($) => $.legacy.title)
    : isRegistering
      ? t(($) => $.signup.title)
      : t(($) => $.signin.title);
  const description = isLegacy
    ? legacyStep === "enroll"
      ? t(($) => $.legacy.password_description)
      : t(($) => $.legacy.description)
    : isRegistering
      ? t(($) => $.signup.description)
      : t(($) => $.signin.description);
  const submitLabel = loading
    ? isLegacy
      ? legacyStep === "request"
        ? t(($) => $.legacy.sending_code)
        : legacyStep === "verify"
          ? t(($) => $.legacy.verifying)
          : t(($) => $.legacy.enrolling)
      : isRegistering
        ? t(($) => $.signup.submitting)
        : t(($) => $.signin.submitting)
    : isLegacy
      ? legacyStep === "request"
        ? t(($) => $.legacy.send_code)
        : legacyStep === "verify"
          ? t(($) => $.legacy.verify)
          : t(($) => $.legacy.enroll)
      : isRegistering
        ? t(($) => $.signup.submit)
        : t(($) => $.signin.submit);

  return (
    <div className="flex min-h-svh items-center justify-center">
      <Card className="w-full max-w-sm">
        <CardHeader className="text-center">
          {logo && <div className="mx-auto mb-4">{logo}</div>}
          <CardTitle className="text-display-sm">{title}</CardTitle>
          <CardDescription>{description}</CardDescription>
        </CardHeader>
        <CardContent>
          <form id="login-form" onSubmit={handleCredentials} className="space-y-4">
            <div className="space-y-2">
              <Label htmlFor="login-email">{t(($) => $.common.email)}</Label>
              <Input
                id="login-email"
                type="email"
                placeholder={t(($) => $.common.email_placeholder)}
                value={email}
                onChange={(event) => setEmail(event.target.value)}
                autoComplete="email"
                autoFocus
                disabled={isLegacy && legacyStep === "enroll"}
                required
              />
            </div>
            {(!isLegacy || legacyStep === "enroll") && (
              <div className="space-y-2">
                <Label htmlFor="login-password">{t(($) => $.common.password)}</Label>
                <Input
                  id="login-password"
                  type="password"
                  placeholder={t(($) => $.common.password_placeholder)}
                  value={password}
                  onChange={(event) => setPassword(event.target.value)}
                  autoComplete={isRegistering || isLegacy ? "new-password" : "current-password"}
                  minLength={8}
                  required
                />
              </div>
            )}
            {isLegacy && legacyStep === "verify" && (
              <div className="space-y-2">
                <Label htmlFor="legacy-verification-code">{t(($) => $.legacy.code)}</Label>
                <Input
                  id="legacy-verification-code"
                  inputMode="numeric"
                  autoComplete="one-time-code"
                  placeholder={t(($) => $.legacy.code_placeholder)}
                  value={verificationCode}
                  onChange={(event) => setVerificationCode(event.target.value.replace(/\D/g, "").slice(0, 6))}
                  required
                />
              </div>
            )}
            {error && (
              <p className="text-body text-destructive" role="alert" aria-live="polite">
                {error}
              </p>
            )}
          </form>
        </CardContent>
        <CardFooter className="flex flex-col gap-3">
          <Button
            type="submit"
            form="login-form"
            className="w-full"
            size="lg"
            disabled={
              !email ||
              loading ||
              ((!isLegacy || legacyStep === "enroll") && !password) ||
              (isLegacy && legacyStep === "verify" && !verificationCode)
            }
          >
            {submitLabel}
          </Button>
          {isLegacy ? (
            <button
              type="button"
              className="text-center text-body text-primary underline-offset-4 hover:underline"
              onClick={() => {
                setMode("login");
                setLegacyStep("request");
                setVerificationCode("");
                setPassword("");
                setError("");
              }}
            >
              {t(($) => $.legacy.back_to_signin)}
            </button>
          ) : (
            <>
              <p className="text-center text-body text-muted-foreground">
                {isRegistering ? t(($) => $.signup.switch_prompt) : t(($) => $.signin.switch_prompt)}{" "}
                <button
                  type="button"
                  className="text-primary underline-offset-4 hover:underline"
                  onClick={() => {
                    setMode(isRegistering ? "login" : "register");
                    setError("");
                  }}
                >
                  {isRegistering ? t(($) => $.signup.switch_action) : t(($) => $.signin.switch_action)}
                </button>
              </p>
              {legacyAuthEnabled && !cliCallback && (
                <p className="text-center text-body text-muted-foreground">
                  {t(($) => $.legacy.switch_prompt)}{" "}
                  <button
                    type="button"
                    className="text-primary underline-offset-4 hover:underline"
                    onClick={() => {
                      setMode("legacy");
                      setLegacyStep("request");
                      setVerificationCode("");
                      setPassword("");
                      setError("");
                    }}
                  >
                    {t(($) => $.legacy.switch_action)}
                  </button>
                </p>
              )}
            </>
          )}
          {extra && <div className="w-full pt-1 text-center">{extra}</div>}
        </CardFooter>
      </Card>
    </div>
  );
}
