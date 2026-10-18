import * as React from "react";
import {
  type HTMLMotionProps,
  motion,
  type SpringOptions,
  type Transition,
  useMotionValue,
  useReducedMotion,
  useSpring,
} from "motion/react";

import { cn } from "@/lib/utils";
import "./stars.css";

type StarLayerProps = HTMLMotionProps<"div"> & {
  count: number;
  size: number;
  transition: Transition;
  starColor: string;
};

function generateStars(count: number, starColor: string) {
  const shadows: string[] = [];
  for (let i = 0; i < count; i++) {
    const x = Math.floor(Math.random() * 4000) - 2000;
    const y = Math.floor(Math.random() * 4000) - 2000;
    shadows.push(`${x}px ${y}px ${starColor}`);
  }
  return shadows.join(", ");
}

function StarLayer({
  count = 1000,
  size = 1,
  transition = { repeat: Infinity, duration: 50, ease: "linear" },
  starColor = "#fff",
  className,
  ...props
}: StarLayerProps) {
  const reduced = useReducedMotion();
  const [boxShadow, setBoxShadow] = React.useState<string>("");

  React.useEffect(() => {
    setBoxShadow(generateStars(count, starColor));
  }, [count, starColor]);

  return (
    <motion.div
      data-slot="star-layer"
      /* #119: reduced motion means a static starfield, no repeating translate. */
      animate={reduced ? undefined : { y: [0, -2000] }}
      transition={reduced ? { repeat: 0, duration: 0 } : transition}
      className={cn("lb-stars-layer", className)}
      {...props}
    >
      <div
        className="lb-stars-dot"
        style={{
          width: `${size}px`,
          height: `${size}px`,
          boxShadow: boxShadow,
        }}
      />
      <div
        className="lb-stars-dot lb-stars-dot-b"
        style={{
          width: `${size}px`,
          height: `${size}px`,
          boxShadow: boxShadow,
        }}
      />
    </motion.div>
  );
}

type StarsBackgroundProps = React.ComponentProps<"div"> & {
  factor?: number;
  speed?: number;
  transition?: SpringOptions;
  starColor?: string;
};

export function StarsBackground({
  children,
  className,
  factor = 0.05,
  speed = 50,
  transition = { stiffness: 50, damping: 20 },
  starColor = "#fff",
  ...props
}: StarsBackgroundProps) {
  const reduced = useReducedMotion();
  const offsetX = useMotionValue(1);
  const offsetY = useMotionValue(1);

  const springX = useSpring(offsetX, transition);
  const springY = useSpring(offsetY, transition);

  /* Deviation from the shadcn source: the parallax listens on
     window, not on this div. In this app the background layer is
     portaled behind the app chrome (z-index -1), so a div-level
     onMouseMove would only fire over uncovered background pixels
     and the parallax would look broken everywhere else. */
  /* #119: reduced motion disables the pointer parallax too. */
  React.useEffect(() => {
    if (reduced) return;
    const onMove = (e: MouseEvent) => {
      const centerX = window.innerWidth / 2;
      const centerY = window.innerHeight / 2;
      offsetX.set(-(e.clientX - centerX) * factor);
      offsetY.set(-(e.clientY - centerY) * factor);
    };
    window.addEventListener("mousemove", onMove, { passive: true });
    return () => window.removeEventListener("mousemove", onMove);
  }, [offsetX, offsetY, factor, reduced]);

  return (
    <div data-slot="stars-background" className={cn("lb-stars", className)} {...props}>
      <motion.div style={{ x: springX, y: springY }}>
        <StarLayer
          count={1000}
          size={1}
          transition={{ repeat: Infinity, duration: speed, ease: "linear" }}
          starColor={starColor}
        />
        <StarLayer
          count={400}
          size={2}
          transition={{ repeat: Infinity, duration: speed * 2, ease: "linear" }}
          starColor={starColor}
        />
        <StarLayer
          count={200}
          size={3}
          transition={{ repeat: Infinity, duration: speed * 3, ease: "linear" }}
          starColor={starColor}
        />
      </motion.div>
      {children}
    </div>
  );
}

export default StarsBackground;
