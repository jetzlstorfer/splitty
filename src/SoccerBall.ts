import { createLucideIcon } from "lucide-react";

// Lucide has no soccer ball icon; this follows its 24px grid and stroke conventions.
export const SoccerBall = createLucideIcon("soccer-ball", [
  ["circle", { cx: "12", cy: "12", r: "10", key: "outline" }],
  ["path", { d: "m12 7.5 4 2.9-1.5 4.6h-5L8 10.4z", key: "center" }],
  ["path", { d: "M12 7.5V2m4 8.4 5.3-1.9M14.5 15l3.5 5m-8.5-5L6 20m2-9.6L2.7 8.5", key: "seams" }]
]);
