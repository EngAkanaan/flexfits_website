
export enum Category {
  SHOES = 'Shoes',
  SOCKS = 'Socks',
  UNDERWEAR = 'Underwear'
}

export type ProductGender = 'Men' | 'Women' | 'Unisex';

export interface Product {
  id: string;
  name: string;
  brandName: string;
  productName: string;
  gender: ProductGender;
  category: Category;
  type: string;
  price: number;
  cost: number;
  initialStock: number; // Original quantity added
  pieces: number;       // Items Left
  sold: number;         // Items Sold
  sizes: string[];
  description: string;
  image: string;
  isAuthentic: boolean;
  status?: string;      // Product status (Active, Discontinued, etc.)
  /** Canonical list (lowercase tokens), synced with Supabase `colors` text[] */
  colors?: string[];
  /** Legacy comma-separated string; prefer `colors` */
  color?: string;
}

export interface Order {
  id: string;
  customerName: string;
  customerEmail: string;
  customerPhone: string;
  governorate: string;
  district: string;
  village: string;
  addressDetails: string;
  items: { productId: string; productName: string; quantity: number; size: string; price: number; reservationId?: string }[];
  total: number;
  status: 'pending' | 'shipped' | 'delivered' | 'cancelled';
  date: string;
}

export interface CartItem extends Product {
  quantity: number;
  selectedSize: string;
  reservationId?: string;
  reservedAt?: string;
  expiresAt?: string;
}

export interface StockReservation {
  id: string;
  productId: string;
  size: string;
  quantity: number;
  sessionId: string;
  status: 'active' | 'confirmed' | 'released';
  reservedAt: string;
  expiresAt: string;
  orderId?: string | null;
}

export interface FinancialMetric {
  productId: string;
  productName: string;
  itemsSold: number;
  itemPrice: number;
  itemCost: number;
  revenue: number;
  netProfit: number;
  calculatedAt: string;
}

export interface FinancialTotals {
  totalRevenue: number;
  totalNetProfit: number;
  calculatedAt: string;
}

export type View = 'home' | 'shop' | 'admin' | 'cart' | 'checkout';
