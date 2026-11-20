import {
  ArrowDownLeft, Bus, Car, Coffee, createLucideIcon, Fuel, Gift, GraduationCap, HeartPulse, House,
  PawPrint, Pill, Plane, Receipt, Scissors, ShieldCheck, ShoppingBag, ShoppingBasket,
  Sparkles, SquareParking, Ticket, Utensils, Wifi, Zap, type LucideIcon
} from "lucide-react";
import { categoryLabels, type Category } from "./categories";
import { useLocale } from "./i18n";

const SoccerBall = createLucideIcon("soccer-ball", [
  ["circle", { cx: "12", cy: "12", r: "10", key: "outline" }],
  ["path", { d: "m12 7.5 4 2.9-1.5 4.6h-5L8 10.4z", key: "center" }],
  ["path", { d: "M12 7.5V2m4 8.4 5.3-1.9M14.5 15l3.5 5m-8.5-5L6 20m2-9.6L2.7 8.5", key: "seams" }]
]);

const icons: Record<Category, LucideIcon> = {
  general: Receipt, groceries: ShoppingBasket, fuel: Fuel, cleaning: Sparkles,
  hairdresser: Scissors, pharmacy: Pill, restaurant: Utensils, coffee: Coffee,
  transport: Bus, parking: SquareParking, car: Car, home: House, utilities: Zap,
  internet: Wifi, shopping: ShoppingBag, health: HeartPulse, pets: PawPrint,
  entertainment: Ticket, travel: Plane, gifts: Gift, insurance: ShieldCheck,
  education: GraduationCap, sports: SoccerBall, payment: ArrowDownLeft
};

export default function ExpenseIcon({ category, size = 20 }: { category: Category; size?: number }) {
  const { t } = useLocale();
  const Icon = icons[category];
  return <span className={`expense-icon category-${category}`} data-category={category} role="img" aria-label={t(categoryLabels[category])}>
    <Icon size={size} aria-hidden="true" />
  </span>;
}
