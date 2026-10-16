import {
  ArrowDownLeft, Bus, Car, Coffee, Fuel, Gift, GraduationCap, HeartPulse, House,
  PawPrint, Pill, Plane, Receipt, Scissors, ShieldCheck, ShoppingBag, ShoppingBasket,
  Sparkles, SquareParking, Ticket, Utensils, Wifi, Zap, type LucideIcon
} from "lucide-react";
import { categoryLabels, type Category } from "./categories";
import { useLocale } from "./i18n";

const icons: Record<Category, LucideIcon> = {
  general: Receipt, groceries: ShoppingBasket, fuel: Fuel, cleaning: Sparkles,
  hairdresser: Scissors, pharmacy: Pill, restaurant: Utensils, coffee: Coffee,
  transport: Bus, parking: SquareParking, car: Car, home: House, utilities: Zap,
  internet: Wifi, shopping: ShoppingBag, health: HeartPulse, pets: PawPrint,
  entertainment: Ticket, travel: Plane, gifts: Gift, insurance: ShieldCheck,
  education: GraduationCap, payment: ArrowDownLeft
};

export default function ExpenseIcon({ category, size = 20 }: { category: Category; size?: number }) {
  const { t } = useLocale();
  const Icon = icons[category];
  return <span className={`expense-icon category-${category}`} data-category={category} role="img" aria-label={t(categoryLabels[category])}>
    <Icon size={size} aria-hidden="true" />
  </span>;
}
