
export enum Category {
  SHOES = 'Shoes',
  SOCKS = 'Socks',
  UNDERWEAR = 'Underwear'
}

export type ProductGender = 'Men' | 'Women' | 'Unisex';

/**Per-size stock tracking: stock=original amount (fixed), left=currently available, sold=total sold */
export interface ProductSizeStock {
  size: string;
  stock: number; // Original amount added for this size (never changes)
  left: number;  // Currently available for this size (decreases with orders)
  sold: number;  // Total sold for this size (increases with orders)
}

export interface Product {
  Product_ID: string;
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
  sizeStock?: ProductSizeStock[];
  description: string;
  image: string;
  images?: string[];
  isAuthentic: boolean;
  status?: string;      // Product status (Active, Discontinued, etc.)
  originalPrice?: number;
  onSale?: boolean;
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
  status: 'pending' | 'dispatched' | 'delivered' | 'canceled';
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

export type View = 'home' | 'shop' | 'product' | 'admin' | 'cart' | 'checkout';
