import { beforeEach, describe, expect, it, vi } from "vitest";
import { render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import type { ReactElement, ReactNode } from "react";
import { I18nProvider } from "@multica/core/i18n/react";
import enCommon from "../locales/en/common.json";
import enAuth from "../locales/en/auth.json";
import enSettings from "../locales/en/settings.json";

const TEST_RESOURCES = {
  en: { common: enCommon, auth: enAuth, settings: enSettings },
};

function I18nWrapper({ children }: { children: ReactNode }) {
  return (
    <I18nProvider locale="en" resources={TEST_RESOURCES}>
      {children}
    </I18nProvider>
  );
}

function renderWithI18n(ui: ReactElement) {
  return render(ui, { wrapper: I18nWrapper });
}

const mockLogin = vi.hoisted(() => vi.fn());
const mockRegister = vi.hoisted(() => vi.fn());
const mockApiLogin = vi.hoisted(() => vi.fn());
const mockApiRegister = vi.hoisted(() => vi.fn());
const mockApiListWorkspaces = vi.hoisted(() => vi.fn());
const mockApiSetToken = vi.hoisted(() => vi.fn());
const mockApiGetMe = vi.hoisted(() => vi.fn());
const mockApiIssueCliToken = vi.hoisted(() => vi.fn());
const mockSetQueryData = vi.hoisted(() => vi.fn());

vi.mock("@tanstack/react-query", async () => {
  const actual = await vi.importActual<typeof import("@tanstack/react-query")>(
    "@tanstack/react-query",
  );
  return { ...actual, useQueryClient: () => ({ setQueryData: mockSetQueryData }) };
});

vi.mock("@multica/core/auth", () => ({
  useAuthStore: Object.assign(
    (selector?: (state: unknown) => unknown) => {
      const state = { login: mockLogin, register: mockRegister };
      return selector ? selector(state) : state;
    },
    {
      getState: () => ({ login: mockLogin, register: mockRegister }),
    },
  ),
}));

vi.mock("@multica/core/api", () => ({
  api: {
    login: mockApiLogin,
    register: mockApiRegister,
    listWorkspaces: mockApiListWorkspaces,
    setToken: mockApiSetToken,
    getMe: mockApiGetMe,
    issueCliToken: mockApiIssueCliToken,
  },
}));

import { LoginPage, validateCliCallback } from "./login-page";

describe("LoginPage", () => {
  const onSuccess = vi.fn();

  beforeEach(() => {
    vi.clearAllMocks();
    mockApiGetMe.mockRejectedValue(new Error("unauthorized"));
    mockApiListWorkspaces.mockResolvedValue([]);
    localStorage.clear();
    Object.defineProperty(window, "location", {
      writable: true,
      value: { href: "http://localhost:3000" },
    });
  });

  it("renders an email and password sign-in form", () => {
    renderWithI18n(<LoginPage onSuccess={onSuccess} />);

    expect(screen.getByText("Sign in to Multica")).toBeInTheDocument();
    expect(screen.getByLabelText("Email")).toBeInTheDocument();
    expect(screen.getByLabelText("Password")).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Sign in" })).toBeDisabled();
    expect(screen.getByRole("button", { name: "Create one" })).toBeInTheDocument();
  });

  it("logs in, seeds workspaces, and calls onSuccess", async () => {
    mockLogin.mockResolvedValue(undefined);
    mockApiListWorkspaces.mockResolvedValue([{ id: "ws-1" }]);
    const user = userEvent.setup();
    renderWithI18n(<LoginPage onSuccess={onSuccess} />);

    await user.type(screen.getByLabelText("Email"), "user@example.com");
    await user.type(screen.getByLabelText("Password"), "correct-password");
    await user.click(screen.getByRole("button", { name: "Sign in" }));

    await waitFor(() => {
      expect(mockLogin).toHaveBeenCalledWith("user@example.com", "correct-password");
      expect(mockApiListWorkspaces).toHaveBeenCalledOnce();
      expect(mockSetQueryData).toHaveBeenCalledWith(
        expect.arrayContaining(["workspaces", "list"]),
        [{ id: "ws-1" }],
      );
      expect(onSuccess).toHaveBeenCalledOnce();
    });
  });

  it("switches to registration and creates an account", async () => {
    mockRegister.mockResolvedValue(undefined);
    const user = userEvent.setup();
    renderWithI18n(<LoginPage onSuccess={onSuccess} />);

    await user.click(screen.getByRole("button", { name: "Create one" }));
    expect(screen.getByText("Create your Multica account")).toBeInTheDocument();

    await user.type(screen.getByLabelText("Email"), "new@example.com");
    await user.type(screen.getByLabelText("Password"), "correct-password");
    await user.click(screen.getByRole("button", { name: "Create account" }));

    await waitFor(() => {
      expect(mockRegister).toHaveBeenCalledWith("new@example.com", "correct-password");
      expect(onSuccess).toHaveBeenCalledOnce();
    });
  });

  it("shows an authentication error", async () => {
    mockLogin.mockRejectedValue(new Error("Invalid email or password"));
    const user = userEvent.setup();
    renderWithI18n(<LoginPage onSuccess={onSuccess} />);

    await user.type(screen.getByLabelText("Email"), "user@example.com");
    await user.type(screen.getByLabelText("Password"), "wrong-password");
    await user.click(screen.getByRole("button", { name: "Sign in" }));

    expect(await screen.findByRole("alert")).toHaveTextContent("Invalid email or password");
    expect(onSuccess).not.toHaveBeenCalled();
  });

  it("authorizes the CLI with newly entered credentials", async () => {
    mockApiLogin.mockResolvedValue({ token: "cli-token" });
    const onTokenObtained = vi.fn();
    const user = userEvent.setup();
    renderWithI18n(
      <LoginPage
        onSuccess={onSuccess}
        onTokenObtained={onTokenObtained}
        cliCallback={{ url: "http://localhost:9876/callback", state: "abc" }}
      />,
    );

    await user.type(screen.getByLabelText("Email"), "cli@example.com");
    await user.type(screen.getByLabelText("Password"), "correct-password");
    await user.click(screen.getByRole("button", { name: "Sign in" }));

    await waitFor(() => {
      expect(mockApiLogin).toHaveBeenCalledWith("cli@example.com", "correct-password");
      expect(localStorage.getItem("multica_token")).toBe("cli-token");
      expect(mockApiSetToken).toHaveBeenCalledWith("cli-token");
      expect(onTokenObtained).toHaveBeenCalledOnce();
      expect(window.location.href).toContain("http://localhost:9876/callback?token=cli-token&state=abc");
    });
    expect(onSuccess).not.toHaveBeenCalled();
  });

  it("authorizes the CLI with an existing cookie session", async () => {
    mockApiGetMe.mockResolvedValueOnce({
      id: "u-1",
      email: "cookie@example.com",
      name: "Cookie User",
    });
    mockApiIssueCliToken.mockResolvedValue({ token: "fresh-token" });
    const user = userEvent.setup();
    renderWithI18n(
      <LoginPage
        onSuccess={onSuccess}
        cliCallback={{ url: "http://localhost:9876/callback", state: "abc" }}
      />,
    );

    expect(await screen.findByText("Authorize CLI")).toBeInTheDocument();
    await user.click(screen.getByRole("button", { name: "Authorize" }));

    await waitFor(() => {
      expect(mockApiIssueCliToken).toHaveBeenCalledOnce();
      expect(window.location.href).toContain("http://localhost:9876/callback?token=fresh-token&state=abc");
    });
  });

  it("renders a provided logo", () => {
    renderWithI18n(
      <LoginPage onSuccess={onSuccess} logo={<div data-testid="logo">Logo</div>} />,
    );
    expect(screen.getByTestId("logo")).toBeInTheDocument();
  });
});

describe("validateCliCallback", () => {
  it("accepts local and private callback URLs", () => {
    expect(validateCliCallback("http://localhost:9876/callback")).toBe(true);
    expect(validateCliCallback("http://192.168.1.2:9876/callback")).toBe(true);
  });

  it("rejects public and HTTPS callback URLs", () => {
    expect(validateCliCallback("http://evil.example/callback")).toBe(false);
    expect(validateCliCallback("https://localhost:9876/callback")).toBe(false);
  });
});
