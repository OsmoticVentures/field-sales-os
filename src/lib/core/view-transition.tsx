import * as React from "react";

/**
 * React's <ViewTransition>, which Next serves when `experimental.viewTransition`
 * is on (next.config.ts). The released types do not list it yet, so it is read
 * off the module; with no support it renders its children untouched.
 */
const VT = (React as unknown as { ViewTransition?: React.ComponentType<{ children: React.ReactNode }> }).ViewTransition;

export function ScreenTransition({ children }: { children: React.ReactNode }) {
  return VT ? <VT>{children}</VT> : <>{children}</>;
}
