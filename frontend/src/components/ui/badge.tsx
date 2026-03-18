"use client";

import * as React from "react";
import { cva, type VariantProps } from "class-variance-authority";

import { cn } from "@/lib/utils";

const badgeVariants = cva("inline-flex items-center rounded-full border px-2.5 py-0.5 text-xs font-semibold transition-colors", {
  variants: {
    variant: {
      online: "border-emerald-500/30 bg-emerald-500/15 text-emerald-700",
      offline: "border-rose-500/30 bg-rose-500/15 text-rose-700",
      success: "border-emerald-500/30 bg-emerald-500/15 text-emerald-700",
      failed: "border-rose-500/30 bg-rose-500/15 text-rose-700",
      started: "border-amber-500/30 bg-amber-500/15 text-amber-700",
      neutral: "border-border bg-muted text-muted-foreground",
    },
  },
  defaultVariants: {
    variant: "neutral",
  },
});

type BadgeVariant = "online" | "offline" | "success" | "failed" | "started" | "neutral";

export interface BadgeProps extends React.HTMLAttributes<HTMLDivElement> {
  variant?: BadgeVariant;
}

function Badge({ className, variant, ...props }: BadgeProps): JSX.Element {
  return <div className={cn(badgeVariants({ variant }), className)} {...props} />;
}

export { Badge, badgeVariants };