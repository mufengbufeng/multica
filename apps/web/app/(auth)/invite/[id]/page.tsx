"use client";

import { useEffect, useState } from "react";
import { useRouter, useParams } from "next/navigation";
import { useQuery } from "@tanstack/react-query";
import { api } from "@multica/core/api";
import { useAuthStore } from "@multica/core/auth";
import { paths } from "@multica/core/paths";
import { workspaceListOptions } from "@multica/core/workspace/queries";
import { InvitePage } from "@multica/views/invite";

function invitationTokenStorageKey(invitationId: string) {
  return `multica:invitation-token:${invitationId}`;
}

export default function InviteAcceptPage() {
  const router = useRouter();
  const params = useParams<{ id: string }>();
  const user = useAuthStore((s) => s.user);
  const isLoading = useAuthStore((s) => s.isLoading);
  const [claimState, setClaimState] = useState<"idle" | "claiming" | "claimed" | "error">("idle");
  const [claimError, setClaimError] = useState("");
  const { data: wsList = [] } = useQuery({
    ...workspaceListOptions(),
    enabled: !!user,
  });

  // Invitation tokens live in the URL fragment so they never reach the web
  // server, reverse proxies, or referrer headers. Persist the fragment just
  // long enough to survive the login redirect, then scrub it from the URL.
  useEffect(() => {
    if (claimState !== "idle" || isLoading) return;

    const key = invitationTokenStorageKey(params.id);
    const hash = new URLSearchParams(window.location.hash.slice(1));
    const tokenFromFragment = hash.get("token");
    if (tokenFromFragment) {
      window.sessionStorage.setItem(key, tokenFromFragment);
      window.history.replaceState(
        window.history.state,
        "",
        `${window.location.pathname}${window.location.search}`,
      );
    }

    if (!user) {
      router.replace(`${paths.login()}?next=${encodeURIComponent(paths.invite(params.id))}`);
      return;
    }

    const token = window.sessionStorage.getItem(key);
    if (!token) {
      setClaimError("This invitation link is invalid, expired, or was opened in another browser session.");
      setClaimState("error");
      return;
    }

    setClaimState("claiming");
    api
      .claimInvitation(params.id, token)
      .then(() => {
        window.sessionStorage.removeItem(key);
        setClaimState("claimed");
      })
      .catch((error) => {
        setClaimError(error instanceof Error ? error.message : "Unable to open this invitation.");
        setClaimState("error");
      });
  }, [claimState, isLoading, user, router, params.id]);

  if (isLoading || !user || claimState === "idle" || claimState === "claiming") return null;

  if (claimState === "error") {
    return (
      <div className="flex min-h-svh items-center justify-center px-6 text-center text-body text-muted-foreground">
        {claimError}
      </div>
    );
  }

  const onBack =
    wsList.length > 0 ? () => router.push(paths.root()) : undefined;

  return <InvitePage invitationId={params.id} onBack={onBack} />;
}
