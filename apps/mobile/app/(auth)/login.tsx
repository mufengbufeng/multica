import { useState } from "react";
import { KeyboardAvoidingView, Platform, Pressable, View } from "react-native";
import { SafeAreaView } from "react-native-safe-area-context";
import { router } from "expo-router";
import * as Haptics from "expo-haptics";
import { Text } from "@/components/ui/text";
import { TextField } from "@/components/ui/text-field";
import { Button } from "@/components/ui/button";
import { MulticaLogo } from "@/components/brand/multica-logo";
import { useAuthStore } from "@/data/auth-store";
import { mapAuthError } from "@/lib/auth-error";

export default function Login() {
  const login = useAuthStore((s) => s.login);
  const register = useAuthStore((s) => s.register);
  const [mode, setMode] = useState<"login" | "register">("login");
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const isRegistering = mode === "register";
  const title = isRegistering ? "Create your Multica account" : "Sign in to Multica";
  const description = isRegistering
    ? "Create an account with your email and password."
    : "Use your email and password to sign in.";
  const submitLabel = submitting
    ? isRegistering
      ? "Creating account..."
      : "Signing in..."
    : isRegistering
      ? "Create account"
      : "Sign in";
  const switchLabel = isRegistering
    ? "Already have an account? Sign in"
    : "Don't have an account? Create one";

  const onSubmit = async () => {
    const trimmed = email.trim();
    if (!trimmed || !password) return;
    void Haptics.selectionAsync();
    setSubmitting(true);
    setError(null);
    try {
      if (isRegistering) {
        await register(trimmed, password);
      } else {
        await login(trimmed, password);
      }
      void Haptics.notificationAsync(Haptics.NotificationFeedbackType.Success);
      router.replace("/");
    } catch (err) {
      void Haptics.notificationAsync(Haptics.NotificationFeedbackType.Error);
      setError(
        mapAuthError(
          err,
          isRegistering
            ? "Couldn't create your account. Try again."
            : "Couldn't sign in. Try again.",
        ),
      );
    } finally {
      setSubmitting(false);
    }
  };

  return (
    <SafeAreaView className="flex-1 bg-background">
      <KeyboardAvoidingView
        className="flex-1"
        behavior={Platform.OS === "ios" ? "padding" : undefined}
      >
        <View className="flex-1 justify-center px-6 gap-6">
          <View className="items-center gap-3">
            <MulticaLogo size={32} />
            <View className="gap-1 items-center">
              <Text className="text-2xl font-semibold text-foreground">
                {title}
              </Text>
              <Text className="text-sm text-muted-foreground text-center">
                {description}
              </Text>
            </View>
          </View>

          <View className="gap-3">
            <View className="gap-1.5">
              <Text className="text-xs text-muted-foreground">Email</Text>
              <TextField
                autoCapitalize="none"
                autoComplete="email"
                autoFocus
                keyboardType="email-address"
                placeholder="you@example.com"
                value={email}
                onChangeText={setEmail}
                returnKeyType="next"
                editable={!submitting}
                invalid={!!error}
              />
            </View>
            <View className="gap-1.5">
              <Text className="text-xs text-muted-foreground">Password</Text>
              <TextField
                autoCapitalize="none"
                autoComplete={isRegistering ? "new-password" : "current-password"}
                autoCorrect={false}
                placeholder="At least 8 characters"
                secureTextEntry
                value={password}
                onChangeText={setPassword}
                onSubmitEditing={onSubmit}
                returnKeyType="go"
                editable={!submitting}
                invalid={!!error}
              />
            </View>
            {error ? (
              <Text className="text-sm text-destructive">{error}</Text>
            ) : null}
          </View>

          <Button
            size="lg"
            disabled={submitting || !email.trim() || !password}
            onPress={onSubmit}
          >
            <Text>{submitLabel}</Text>
          </Button>
          <Pressable
            accessibilityRole="button"
            disabled={submitting}
            onPress={() => {
              setMode(isRegistering ? "login" : "register");
              setError(null);
            }}
            className="items-center py-2"
          >
            <Text className="text-sm text-primary">{switchLabel}</Text>
          </Pressable>
        </View>
      </KeyboardAvoidingView>
    </SafeAreaView>
  );
}
