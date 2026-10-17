import type { ReactNode } from "react";
import { AuthError } from "./auth";

function describe(error: unknown): { message: string; detail?: string } {
  if (!(error instanceof AuthError)) {
    return { message: "Something went wrong. Try again." };
  }
  switch (error.code) {
    case "invalid_credentials":
      // The api gives a wrong password and an unknown email the same answer,
      // so this cannot say which it was.
      return {
        message:
          "That email and password don't match an account. Check them and try again.",
      };
    case "invalid_request":
      return {
        message: `${error.message.charAt(0).toUpperCase()}${error.message.slice(1)}.`,
      };
    case "email_taken":
      return { message: "An account with that email already exists." };
    case null:
      return {
        message: `Can't reach the API: ${error.message}. Check the api container is running (docker compose ps), then try again.`,
      };
    default:
      return {
        message: "Something went wrong. Try again.",
        detail: `Error: ${error.code}`,
      };
  }
}

export function AuthErrorMessage({
  error,
  children,
}: {
  error: unknown;
  children?: ReactNode;
}) {
  const { message, detail } = describe(error);
  return (
    <div role="alert" className="health" data-tone="bad">
      <p>{message}</p>
      {detail && <p className="detail">{detail}</p>}
      {children}
    </div>
  );
}
