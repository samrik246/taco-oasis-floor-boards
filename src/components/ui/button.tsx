import * as React from "react";
import { Slot } from "@radix-ui/react-slot";
import { cva, type VariantProps } from "class-variance-authority";
import { cn } from "@/lib/utils";

const buttonVariants = cva(
  "inline-flex items-center justify-center gap-2 whitespace-nowrap rounded-md text-sm font-medium transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-neutral-900 disabled:pointer-events-none disabled:opacity-50 touch-manipulation",
  {
    variants: {
      variant: {
        // active: for touch; hover: optional enhancement — never hover-only
        default:
          "bg-neutral-900 text-neutral-50 active:bg-neutral-700 hover:bg-neutral-800",
        outline:
          "border border-neutral-200 bg-white active:bg-neutral-200 hover:bg-neutral-100",
        ghost: "active:bg-neutral-200 hover:bg-neutral-100",
      },
      size: {
        default: "min-h-11 h-11 px-4 py-2",
        sm: "min-h-11 h-11 rounded-md px-3 text-xs",
        lg: "min-h-12 h-12 rounded-md px-8",
      },
    },
    defaultVariants: {
      variant: "default",
      size: "default",
    },
  },
);

export interface ButtonProps
  extends React.ButtonHTMLAttributes<HTMLButtonElement>,
    VariantProps<typeof buttonVariants> {
  asChild?: boolean;
}

const Button = React.forwardRef<HTMLButtonElement, ButtonProps>(
  ({ className, variant, size, asChild = false, ...props }, ref) => {
    const Comp = asChild ? Slot : "button";
    return (
      <Comp
        className={cn(buttonVariants({ variant, size, className }))}
        ref={ref}
        {...props}
      />
    );
  },
);
Button.displayName = "Button";

export { Button, buttonVariants };
