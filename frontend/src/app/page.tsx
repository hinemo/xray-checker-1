"use client";

import { useEffect } from "react";

export default function RootPage() {
  useEffect(() => {
    window.location.replace("/zh/");
  }, []);

  return (
    <main className="min-h-screen flex items-center justify-center text-sm text-muted-foreground">
      Redirecting...
    </main>
  );
}
