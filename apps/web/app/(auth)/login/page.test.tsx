import { beforeEach, describe, expect, it, vi } from "vitest";
import { render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { I18nProvider } from "@multica/core/i18n/react";
import enCommon from "@multica/views/locales/en/common.json";
import enAuth from "@multica/views/locales/en/auth.json";
import enSettings from "@multica/views/locales/en/settings.json";
import type { ReactNode } from "react";

const TEST_RESOURCES = {
  en: { common: enCommon, auth: enAuth, settings: enSettings },
};

function createWrapper() {
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  return ({ children }: { children: ReactNode }) => (
    <I18nProvider locale="en" resources={TEST_RESOURCES}>
      <QueryClientProvider client={qc}>{children}</QueryClientProvider>
    </I18nProvider>
  );
}

const {
  mockLogin,
  mockRegister,
  mockIssueCliToken,
  mockListWorkspaces,
  mockListMyInvitations,
  mockPush,
  mockReplace,
  searchParamsState,
  authStateRef,
} = vi.hoisted(() => ({
  mockLogin: vi.fn(),
  mockRegister: vi.fn(),
  mockIssueCliToken: vi.fn(),
  mockListWorkspaces: vi.fn(),
  mockListMyInvitations: vi.fn(),
  mockPush: vi.fn(),
  mockReplace: vi.fn(),
  searchParamsState: { params: new URLSearchParams() },
  authStateRef: {
    state: {
      login: vi.fn(),
      register: vi.fn(),
      user: null as null | { id: string; email: string; onboarded_at?: string | null },
      isLoading: false,
    },
  },
}));

vi.mock("next/navigation", () => ({
  useRouter: () => ({ push: mockPush, replace: mockReplace }),
  usePathname: () => "/login",
  useSearchParams: () => searchParamsState.params,
}));

vi.mock("@multica/core/auth", async () => {
  const actual = await vi.importActual<typeof import("@multica/core/auth")>(
    "@multica/core/auth",
  );
  authStateRef.state.login = mockLogin;
  authStateRef.state.register = mockRegister;
  const useAuthStore = Object.assign(
    (selector: (state: typeof authStateRef.state) => unknown) => selector(authStateRef.state),
    { getState: () => authStateRef.state },
  );
  return { ...actual, useAuthStore };
});

vi.mock("@/features/auth/auth-cookie", () => ({
  setLoggedInCookie: vi.fn(),
}));

vi.mock("@multica/core/api", () => ({
  api: {
    login: vi.fn(),
    register: vi.fn(),
    listWorkspaces: mockListWorkspaces,
    listMyInvitations: mockListMyInvitations,
    setToken: vi.fn(),
    getMe: vi.fn(),
    issueCliToken: mockIssueCliToken,
  },
}));

import LoginPage from "./page";

const onboardedUser = {
  id: "u1",
  email: "test@multica.ai",
  onboarded_at: "2026-01-01T00:00:00Z",
};

describe("LoginPage", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    searchParamsState.params = new URLSearchParams();
    authStateRef.state.user = null;
    authStateRef.state.isLoading = false;
    mockListWorkspaces.mockResolvedValue([]);
    mockListMyInvitations.mockResolvedValue([]);
  });

  it("renders the password sign-in form", () => {
    render(<LoginPage />, { wrapper: createWrapper() });

    expect(screen.getByText("Sign in to Multica")).toBeInTheDocument();
    expect(screen.getByLabelText("Email")).toBeInTheDocument();
    expect(screen.getByLabelText("Password")).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Sign in" })).toBeDisabled();
  });

  it("navigates after a fresh credential login", async () => {
    authStateRef.state.user = null;
    mockLogin.mockImplementation(async () => {
      authStateRef.state.user = onboardedUser;
    });
    mockListWorkspaces.mockResolvedValue([{ id: "ws-1", slug: "acme" }]);
    const user = userEvent.setup();
    render(<LoginPage />, { wrapper: createWrapper() });

    await user.type(screen.getByLabelText("Email"), "test@multica.ai");
    await user.type(screen.getByLabelText("Password"), "correct-password");
    await user.click(screen.getByRole("button", { name: "Sign in" }));

    await waitFor(() => {
      expect(mockLogin).toHaveBeenCalledWith("test@multica.ai", "correct-password");
      expect(mockPush).toHaveBeenCalledWith("/acme/issues");
    });
    expect(mockReplace).not.toHaveBeenCalled();
  });

  it("fetches workspaces before redirecting a visitor who arrived authenticated", async () => {
    authStateRef.state.user = onboardedUser;
    mockListWorkspaces.mockResolvedValue([{ id: "ws-1", slug: "acme" }]);

    render(<LoginPage />, { wrapper: createWrapper() });

    await waitFor(() => {
      expect(mockReplace).toHaveBeenCalledWith("/acme/issues");
    });
    expect(mockListWorkspaces).toHaveBeenCalledOnce();
  });

  it("honors a safe next URL for a visitor who arrived authenticated", async () => {
    searchParamsState.params = new URLSearchParams({ next: "/invite/abc" });
    authStateRef.state.user = onboardedUser;

    render(<LoginPage />, { wrapper: createWrapper() });

    await waitFor(() => {
      expect(mockReplace).toHaveBeenCalledWith("/invite/abc");
    });
    expect(mockListWorkspaces).not.toHaveBeenCalled();
  });

  it("mints a token and deep-links to Desktop for an existing browser session", async () => {
    searchParamsState.params = new URLSearchParams({ platform: "desktop" });
    authStateRef.state.user = onboardedUser;
    mockIssueCliToken.mockResolvedValue({ token: "handoff-jwt" });

    const hrefSetter = vi.fn();
    const originalLocation = window.location;
    Object.defineProperty(window, "location", {
      configurable: true,
      value: { ...originalLocation, set href(value: string) { hrefSetter(value); } },
    });

    try {
      render(<LoginPage />, { wrapper: createWrapper() });

      await waitFor(() => {
        expect(mockIssueCliToken).toHaveBeenCalledOnce();
        expect(hrefSetter).toHaveBeenCalledWith("multica://auth/callback?token=handoff-jwt");
      });
      expect(await screen.findByRole("button", { name: "Open Multica Desktop" })).toBeInTheDocument();
    } finally {
      Object.defineProperty(window, "location", {
        configurable: true,
        value: originalLocation,
      });
    }
  });

  it("mints a desktop handoff token after a fresh credential login", async () => {
    searchParamsState.params = new URLSearchParams({ platform: "desktop" });
    mockLogin.mockImplementation(async () => {
      authStateRef.state.user = onboardedUser;
    });
    mockIssueCliToken.mockResolvedValue({ token: "handoff-jwt" });
    const hrefSetter = vi.fn();
    const originalLocation = window.location;
    Object.defineProperty(window, "location", {
      configurable: true,
      value: { ...originalLocation, set href(value: string) { hrefSetter(value); } },
    });

    try {
      const user = userEvent.setup();
      render(<LoginPage />, { wrapper: createWrapper() });
      await user.type(screen.getByLabelText("Email"), "test@multica.ai");
      await user.type(screen.getByLabelText("Password"), "correct-password");
      await user.click(screen.getByRole("button", { name: "Sign in" }));

      await waitFor(() => {
        expect(mockIssueCliToken).toHaveBeenCalledOnce();
        expect(hrefSetter).toHaveBeenCalledWith("multica://auth/callback?token=handoff-jwt");
      });
      expect(mockPush).not.toHaveBeenCalled();
    } finally {
      Object.defineProperty(window, "location", {
        configurable: true,
        value: originalLocation,
      });
    }
  });
});
