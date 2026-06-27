
import React, { useState, useEffect, useMemo, useRef, useCallback, useDeferredValue } from 'react';
import { ShoppingBag, User, Search, Filter, Trash2, Plus, LogOut, ChevronRight, CheckCircle, Package, BarChart3, Menu, X, Star, ExternalLink, Edit2, Upload, Download, Phone, MapPin, Truck, Check, Mail, List, Layers, Info, Palette, MessageCircle, Tag as TagIcon } from 'lucide-react';
import * as XLSX from 'xlsx';
import { Category, Product, ProductGender, ProductSizeStock, Order, CartItem, FinancialMetric, FinancialTotals, View, Tag } from './types';
import { INITIAL_PRODUCTS, ADMIN_CREDENTIALS, ADMIN_USER, ADMIN_PASS, LEBANON_LOCATIONS, SIZE_OPTIONS } from './constants';
import { getProductRecommendation } from './services/gemini';
import { getProducts, saveProduct, deleteProduct, getOrders, saveOrder, updateOrderStatus, deleteOrder, recalculateFinancialMetrics, getFinancialDashboardTotals, reserveCartLine, releaseCartLineReservation, cleanupExpiredReservations, extendExpiredReservation, getProductColorTokens, uploadProductImagesToStorage, normalizeOrderStatus, getTags, generateOrderId } from './services/database';
import { supabase } from './services/supabase';
import AnnouncementBar from './components/AnnouncementBar';
import HeroBannerSlider from './components/HeroBannerSlider';
import HomepageSections from './components/HomepageSections';
import EditThemePanel from './components/EditThemePanel';
import TagsManagerPanel from './components/TagsManagerPanel';

const BRAND_LOGO_SRC = '/flex-logo.JPG';
const DELIVERY_FEE = 5;
const GENDER_OPTIONS: ProductGender[] = ['Men', 'Women', 'Unisex'];
const NUMERIC_SIZE_FILTER_OPTIONS = Array.from({ length: 16 }, (_, i) => String(35 + i));
const CLOTHING_SIZE_FILTER_OPTIONS = ['S', 'M', 'L', 'XL'];
const CART_STORAGE_KEY = 'flex_cart';
const ADMIN_AUTH_STORAGE_KEY = 'flex_admin_auth';

function ColorTagInput({
  value,
  onChange,
  suggestions,
}: {
  value: string[];
  onChange: (next: string[]) => void;
  suggestions: string[];
}) {
  const [draft, setDraft] = useState('');
  const addToken = (raw: string) => {
    const t = String(raw || '')
      .trim()
      .toLowerCase();
    if (!t || value.includes(t)) {
      setDraft('');
      return;
    }
    onChange([...value, t]);
    setDraft('');
  };
  const filteredSuggestions = suggestions.filter(
    (s) =>
      s.includes(draft.trim().toLowerCase()) &&
      !value.includes(s) &&
      s.trim()
  ).slice(0, 12);

  return (
    <div className="space-y-2 mt-1">
      <div className="flex flex-wrap gap-1.5 min-h-[36px] p-2 bg-gray-50 border rounded-2xl">
        {value.map((c) => (
          <span
            key={c}
            className="inline-flex items-center gap-1 pl-2 pr-1 py-0.5 rounded-full bg-orange-100 text-orange-800 text-[11px] font-bold uppercase"
          >
            {c}
            <button
              type="button"
              className="p-0.5 rounded-full hover:bg-orange-200 text-orange-900"
              onClick={() => onChange(value.filter((x) => x !== c))}
              aria-label={`Remove ${c}`}
            >
              <X size={12} />
            </button>
          </span>
        ))}
        <input
          className="flex-1 min-w-[120px] bg-transparent border-none outline-none text-sm font-bold placeholder:text-gray-400"
          placeholder="Type color, Enter to add"
          value={draft}
          onChange={(e) => setDraft(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === 'Enter') {
              e.preventDefault();
              addToken(draft);
            }
          }}
          list="flexfits-color-suggestions"
        />
      </div>
      {filteredSuggestions.length > 0 && (
        <div className="flex flex-wrap gap-1">
          {filteredSuggestions.map((s) => (
            <button
              key={s}
              type="button"
              onClick={() => addToken(s)}
              className="text-[10px] font-black uppercase px-2 py-0.5 rounded-full border border-gray-200 text-gray-600 hover:border-orange-400 hover:text-orange-700"
            >
              + {s}
            </button>
          ))}
        </div>
      )}
      <datalist id="flexfits-color-suggestions">
        {suggestions.map((s) => (
          <option key={s} value={s} />
        ))}
      </datalist>
    </div>
  );
}


// --- No InventoryStockEditor: replaced by direct stock/items_sold editing in admin UI ---

function getInitialCartState(): CartItem[] {
  try {
    const saved = localStorage.getItem(CART_STORAGE_KEY);
    if (!saved) return [];
    const parsed = JSON.parse(saved);
    return Array.isArray(parsed) ? (parsed as CartItem[]) : [];
  } catch {
    return [];
  }
}

function routeFromPathname(pathname: string): { view: View; productId: string | null } {
  const normalized = String(pathname || '/').trim();
  const normalizedPath = normalized.length > 1 && normalized.endsWith('/')
    ? normalized.slice(0, -1)
    : normalized;
  const lower = normalizedPath.toLowerCase();
  if (lower.startsWith('/product/')) {
    const productId = decodeURIComponent(normalizedPath.slice('/product/'.length)).trim();
    return { view: 'product', productId: productId || null };
  }
  if (lower === '/admin') return { view: 'admin', productId: null };
  if (lower === '/shop') return { view: 'shop', productId: null };
  if (lower === '/cart' || lower === '/bag') return { view: 'cart', productId: null };
  if (lower === '/checkout') return { view: 'checkout', productId: null };
  return { view: 'home', productId: null };
}

function pathnameFromRoute(view: View, productId: string | null): string {
  if (view === 'product') {
    return productId ? `/product/${encodeURIComponent(productId)}` : '/shop';
  }
  if (view === 'admin') return '/admin';
  if (view === 'shop') return '/shop';
  if (view === 'cart') return '/bag';
  if (view === 'checkout') return '/checkout';
  return '/';
}

function normalizeGender(value: unknown): ProductGender {
  const normalized = String(value || '').trim().toLowerCase();
  if (normalized === 'women' || normalized === 'woman' || normalized === 'female' || normalized === 'ladies') return 'Women';
  if (normalized === 'men' || normalized === 'man' || normalized === 'male' || normalized === 'gents') return 'Men';
  if (normalized === 'unisex' || normalized === 'uni-sex') return 'Unisex';
  return 'Unisex';
}

function parseRangeSize(value: string): { min: number; max: number } | null {
  const match = String(value || '').trim().match(/^(\d{1,3})\s*-\s*(\d{1,3})$/);
  if (!match) return null;
  const min = Number(match[1]);
  const max = Number(match[2]);
  if (!Number.isFinite(min) || !Number.isFinite(max)) return null;
  return { min: Math.min(min, max), max: Math.max(min, max) };
}

function extractBaseNumericSize(value: string): number | null {
  const match = String(value || '').trim().match(/^(\d{1,3})/);
  if (!match) return null;
  const base = Number(match[1]);
  return Number.isFinite(base) ? base : null;
}

function isClothingSizeToken(value: string): boolean {
  const normalized = String(value || '').trim().toUpperCase();
  return CLOTHING_SIZE_FILTER_OPTIONS.includes(normalized);
}

function productMatchesSelectedSizes(productSizes: string[], selectedSizes: string[]): boolean {
  if (!selectedSizes.length) return true;

  const normalizedProductSizes = (productSizes || []).map((s) => String(s || '').trim()).filter(Boolean);
  if (!normalizedProductSizes.length) return false;

  for (const selectedRaw of selectedSizes) {
    const selected = String(selectedRaw || '').trim().toUpperCase();
    if (!selected) continue;

    if (isClothingSizeToken(selected)) {
      const hasClothingMatch = normalizedProductSizes.some((sizeToken) => String(sizeToken).trim().toUpperCase() === selected);
      if (hasClothingMatch) return true;
      continue;
    }

    const selectedNumeric = Number(selected);
    if (!Number.isFinite(selectedNumeric)) {
      const exactStringMatch = normalizedProductSizes.some((sizeToken) => String(sizeToken).trim().toUpperCase() === selected);
      if (exactStringMatch) return true;
      continue;
    }

    for (const productSizeToken of normalizedProductSizes) {
      const range = parseRangeSize(productSizeToken);
      if (range && selectedNumeric >= range.min && selectedNumeric <= range.max) {
        return true;
      }

      const baseSize = extractBaseNumericSize(productSizeToken);
      if (baseSize !== null && baseSize === selectedNumeric) {
        return true;
      }
    }
  }

  return false;
}

function normalizeSizeStockEntries(product: Product): ProductSizeStock[] {
  if (Array.isArray(product.sizeStock) && product.sizeStock.length > 0) {
    return product.sizeStock
      .map((entry) => ({
        size: String(entry?.size || '').trim(),
        stock: Math.max(
          0,
          Math.floor(
            Number(
              entry?.stock || 0
            )
          )
        ),
        sold: Math.max(0, Math.floor(Number(entry?.sold || 0))),
        left: Math.max(
          0,
          Math.floor(
            Number(
              entry?.left || 0
            )
          )
        ),
      }))
      .map((entry) => {
        const clampedSold = Math.min(entry.stock, Math.max(0, entry.sold));
        const clampedLeft = Math.min(entry.stock, Math.max(0, entry.left));
        return {
          ...entry,
          sold: clampedSold,
          left: clampedLeft,
        };
      })
      .filter((entry) => entry.size);
  }

  const fallbackPieces = Math.max(0, Math.floor(Number(product.pieces || 0)));
  const sizes = (product.sizes || []).map((size) => String(size || '').trim()).filter(Boolean);
  if (sizes.length === 0) return [];
  return sizes.map((size, index) => {
    const perSize = Math.floor(fallbackPieces / sizes.length);
    const extra = index < (fallbackPieces % sizes.length) ? 1 : 0;
    const stock = Math.max(0, perSize + extra);
    return { size, stock, left: stock, sold: 0 };
  });
}

function normalizeCustomerProductStatus(value: unknown): string {
  const normalized = String(value || '').trim().toLowerCase();
  return normalized;
}

function isProductVisibleToCustomer(product: Product): boolean {
  return normalizeCustomerProductStatus((product as any).Status ?? product.status ?? '') !== 'discontinued';
}

function isProductPurchasableForCustomer(product: Product): boolean {
  return getProductAvailabilityState(product) === 'available';
}

function getCommittedAvailableForSize(product: Product, size: string): number {
  const normalizedSize = String(size || '').trim();
  const sizeEntries = normalizeSizeStockEntries(product);
  const match = sizeEntries.find((entry) => String(entry.size || '').trim() === normalizedSize);
  if (match) {
    const stock = Math.max(0, Math.floor(Number(match.stock || 0)));
    const sold = Math.max(0, Math.floor(Number(match.sold || 0)));
    return Math.max(0, stock - sold);
  }

  if (sizeEntries.length > 0) return 0;

  const totalStock = Math.max(0, Math.floor(Number(product.initialStock || 0)));
  const totalSold = Math.max(0, Math.floor(Number(product.sold || 0)));
  return Math.max(0, totalStock - totalSold);
}

function getProductAvailabilityState(product: Product): 'available' | 'reserved' | 'unavailable' | 'coming_soon' | 'discontinued' {
  const normalizedStatus = normalizeCustomerProductStatus((product as any).Status ?? product.status ?? '');
  if (normalizedStatus === 'discontinued') return 'discontinued';
  if (normalizedStatus === 'coming soon') return 'coming_soon';
  if (normalizedStatus === 'out of stock') return 'unavailable';

  const visibleLeftNow = getTotalSizeStock(product);
  if (visibleLeftNow > 0) return 'available';

  const committed = getProductStockTotals(product);
  const committedAvailable = Math.max(0, committed.stock - committed.sold);
  if (committedAvailable > 0) return 'reserved';

  return 'unavailable';
}

function getProductStockTotals(product: Product): { stock: number; sold: number; left: number } {
  const entries = normalizeSizeStockEntries(product);
  if (entries.length > 0) {
    const stock = entries.reduce((sum, entry) => sum + Math.max(0, Math.floor(Number(entry.stock || 0))), 0);
    const sold = entries.reduce((sum, entry) => sum + Math.max(0, Math.floor(Number(entry.sold || 0))), 0);
    const left = entries.reduce((sum, entry) => sum + Math.max(0, Math.floor(Number(entry.left || 0))), 0);
    return { stock, sold, left };
  }
  const stock = Math.max(0, Math.floor(Number(product.initialStock || 0)));
  const sold = Math.max(0, Math.floor(Number(product.sold || 0)));
  return { stock, sold, left: Math.max(0, stock - sold) };
}

/**
 * Bulk-edit "Stock" field sets how many are currently available (left), leaving sold history
 * untouched. For size-based products, the new left-total is distributed evenly across the
 * product's existing sizes; each size's stock is recomputed as sold + its share of left, so it
 * can never dip below what's already sold.
 */
function buildBulkStockUpdate(product: Product, newPiecesLeft: number): { initialStock: number; pieces: number; sizeStock?: ProductSizeStock[] } {
  const existingSizeStock = normalizeSizeStockEntries(product);
  if (existingSizeStock.length === 0) {
    const sold = Math.max(0, Math.floor(Number(product.sold || 0)));
    return { initialStock: sold + newPiecesLeft, pieces: newPiecesLeft };
  }

  const sizes = existingSizeStock.map((entry) => entry.size);
  const soldBySize = existingSizeStock.map((entry) => Math.max(0, Math.floor(Number(entry.sold || 0))));
  const nextSizeStock: ProductSizeStock[] = sizes.map((size, index) => {
    const left = Math.floor(newPiecesLeft / sizes.length) + (index < newPiecesLeft % sizes.length ? 1 : 0);
    return { size, stock: soldBySize[index] + left, sold: soldBySize[index], left };
  });

  return {
    initialStock: nextSizeStock.reduce((sum, entry) => sum + entry.stock, 0),
    pieces: nextSizeStock.reduce((sum, entry) => sum + entry.left, 0),
    sizeStock: nextSizeStock,
  };
}

function getProductImages(product: Product): string[] {
  const images = Array.isArray(product.images) && product.images.length > 0 ? product.images : [product.image];
  return Array.from(new Set(images.map((image) => String(image || '').trim()).filter(Boolean)));
}

function getProductBrandLabel(product: Product): string {
  const explicitBrand = String(product.brandName || '').trim();
  if (explicitBrand) return explicitBrand;

  const fullName = String(product.name || '').trim();
  if (!fullName) return '';
  if (fullName.includes(' - ')) return String(fullName.split(' - ')[0] || '').trim();
  return String(fullName.split(' ')[0] || '').trim();
}

function isValidDataImageUrl(value: string): boolean {
  if (!/^data:image\//i.test(value)) return false;
  return /^data:image\/[a-z0-9.+-]+;base64,[a-z0-9+/=]+$/i.test(value);
}

function isRenderableImageSrc(value: string): boolean {
  if (!value) return false;
  if (/^https?:\/\//i.test(value)) return true;
  // Bounded length keeps this from matching base64 fragments (thousands of chars, no "=" padding
  // in some encodings) that happen to satisfy this character class otherwise.
  if (value.length <= 200 && /^\/[\w./%+-]+$/i.test(value)) return true;
  return isValidDataImageUrl(value);
}

function SafeImage({
  src,
  alt,
  className,
  eager,
}: {
  src: string;
  alt: string;
  className?: string;
  eager?: boolean;
}) {
  const [failed, setFailed] = useState(false);
  const normalizedSrc = String(src || '').trim();

  useEffect(() => {
    setFailed(false);
  }, [normalizedSrc]);

  const resolved = !failed && isRenderableImageSrc(normalizedSrc) ? normalizedSrc : '/flex-logo-bbg.JPG';
  return (
    <img
      src={resolved}
      alt={alt}
      loading={eager ? 'eager' : 'lazy'}
      className={className}
      onError={() => setFailed(true)}
    />
  );
}

function ProductCard({
  product,
  openProduct,
  getSizeStockValue,
  getTotalStock,
}: {
  product: Product;
  openProduct: (product: Product) => void;
  getSizeStockValue: (product: Product, size: string) => number;
  getTotalStock: (product: Product) => number;
}) {
  const images = useMemo(() => getProductImages(product), [product.Product_ID, product.image, product.images]);
  const [hoverImageIndex, setHoverImageIndex] = useState(0);

  useEffect(() => {
    setHoverImageIndex(0);
  }, [product.Product_ID]);

  const [isHovered, setIsHovered] = useState(false);
  useEffect(() => {
    if (!isHovered || images.length <= 1) return;
    const interval = window.setInterval(() => {
      setHoverImageIndex((prev) => (prev + 1) % images.length);
    }, 2500);
    return () => window.clearInterval(interval);
  }, [isHovered, images.length]);

  const availabilityState = getProductAvailabilityState(product);
  const isComingSoon = availabilityState === 'coming_soon';
  const isReserved = availabilityState === 'reserved';
  const isOutOfStock = availabilityState === 'unavailable';
  const cardColors = getProductColorTokens(product);

  return (
    <div
      className="group bg-white p-3 sm:p-4 rounded-2xl border-2 border-gray-50 shadow-sm hover:shadow-3xl transition-all duration-500 flex flex-col h-full relative overflow-hidden min-w-0"
      onMouseEnter={() => setIsHovered(true)}
      onMouseLeave={() => {
        setIsHovered(false);
        setHoverImageIndex(0);
      }}
    >
      <div className="relative aspect-[4/5] rounded-xl overflow-hidden mb-4 bg-white border border-gray-100 flex-shrink-0">
        <button
          onClick={() => openProduct(product)}
          aria-label={`Open ${product.productName || product.name}`}
          className="absolute inset-0 z-10"
        />
        <div className="absolute inset-0 overflow-hidden">
          <div
            className="flex h-full w-full transition-transform duration-700 ease-out will-change-transform"
            style={{ transform: `translateX(-${Math.min(hoverImageIndex, Math.max(0, images.length - 1)) * 100}%)` }}
          >
            {images.length > 0 ? images.map((image, index) => (
              <div key={`${product.Product_ID}-${image}-${index}`} className="h-full w-full flex-shrink-0">
                <SafeImage
                  src={image}
                  alt={product.name}
                  className="w-full h-full object-contain p-2 group-hover:scale-[1.03] transition-transform duration-700"
                />
              </div>
            )) : (
              <div className="h-full w-full flex-shrink-0">
                <SafeImage src={product.image} alt={product.name} className="w-full h-full object-contain p-2 group-hover:scale-[1.03] transition-transform duration-700" />
              </div>
            )}
          </div>
        </div>
        {(isOutOfStock || isComingSoon || isReserved) && (
          <div className={`absolute bottom-2 right-2 text-white text-[8px] font-black uppercase tracking-[0.12em] px-2 py-1 rounded-full shadow-lg ${isComingSoon ? 'bg-blue-600' : isReserved ? 'bg-amber-600' : 'bg-orange-600'}`}>
            {isComingSoon ? 'Coming Soon' : isReserved ? 'Reserved' : 'Out Of Stock'}
          </div>
        )}
      </div>

      <div className="px-2 pb-2 flex-grow flex flex-col">
        <h4 className="font-black text-lg uppercase italic tracking-tighter group-hover:text-orange-600 transition-colors mb-1 text-black leading-none">{product.productName || product.name}</h4>
        <p className="text-[9px] text-gray-300 font-black uppercase tracking-[0.3em] mb-2 italic">{product.category}</p>

        <div className="mb-2 flex items-center justify-between gap-2">
          <span className="text-[9px] font-black uppercase text-gray-400 tracking-widest">Type</span>
          <span className="text-[10px] font-black uppercase tracking-wider text-gray-700">{product.type}</span>
        </div>

        <div className="mb-3 flex items-end justify-between gap-2">
          <span className="text-[9px] font-black uppercase text-gray-400 tracking-widest">Price</span>
          <div className="text-right">
            {product.onSale && product.originalPrice && product.originalPrice > product.price ? (
              <>
                <div className="text-sm font-black text-black">${product.price.toFixed(2)}</div>
                <div className="text-[8px] font-black text-gray-400 line-through">${product.originalPrice.toFixed(2)}</div>
              </>
            ) : (
              <div className="text-sm font-black text-black">${product.price.toFixed(2)}</div>
            )}
          </div>
        </div>

        {cardColors.length > 0 && (
          <div className="flex flex-wrap gap-1 mb-3">
            {cardColors.map((c) => (
              <span key={c} className="text-[8px] font-black uppercase px-2 py-0.5 rounded-full bg-gray-100 text-gray-600 border border-gray-200">
                {c}
              </span>
            ))}
          </div>
        )}

        {product.description && (
          <div className="mb-3 bg-gray-50 p-3 rounded-xl border border-gray-100">
            <p className="text-[11px] text-gray-500 font-medium leading-relaxed italic line-clamp-2">{product.description}</p>
          </div>
        )}

        <div className="mb-3 flex items-center gap-2">
          <span className="text-[9px] font-black uppercase text-gray-400 tracking-widest">In Stock:</span>
          <span className={`text-[11px] font-black ${isOutOfStock ? 'text-red-500' : isReserved ? 'text-amber-600' : getTotalStock(product) < 10 ? 'text-orange-500' : 'text-green-600'}`}>
            {isComingSoon ? 'Coming Soon' : (isReserved ? 'Reserved by another customer' : isOutOfStock ? 'Out of stock' : `${getTotalStock(product)} left`)}
          </span>
        </div>

        <div className="mt-auto pt-3 border-t border-gray-50">
          <div className="mb-2 flex items-center justify-between gap-2">
            <p className="text-[9px] font-black uppercase text-gray-300 tracking-widest italic ml-1">Available Variants</p>
            <button
              onClick={() => openProduct(product)}
              aria-label={`Open ${product.productName || product.name}`}
              className="inline-flex items-center gap-1.5 bg-orange-600 text-white px-2.5 py-1.5 rounded-lg text-[9px] font-black uppercase tracking-wider hover:bg-orange-700 transition-all"
            >
              <ExternalLink size={12} />
              View Product
            </button>
          </div>
          <div className="flex flex-wrap gap-2">
            {product.sizes.map((sizeValue) => {
              const sizeStock = getSizeStockValue(product, sizeValue);
              return (
                <span key={sizeValue} className={`w-10 h-10 border-2 rounded-lg flex flex-col items-center justify-center text-[9px] font-black uppercase italic select-none ${sizeStock <= 0 ? 'border-gray-100 text-gray-300 bg-gray-50' : 'border-gray-100 text-gray-500 bg-white'}`}>
                  <span>{sizeValue}</span>
                  <span className="text-[8px] normal-case tracking-normal">{sizeStock > 0 ? `${sizeStock}` : 'Out'}</span>
                </span>
              );
            })}
          </div>
        </div>
      </div>
    </div>
  );
}

function getTotalSizeStock(product: Product): number {
  if (Array.isArray(product.sizeStock) && product.sizeStock.length > 0) {
    return product.sizeStock.reduce((total, entry) => total + Math.max(0, Math.floor(Number(entry.left ?? entry.stock ?? 0))), 0);
  }
  return Math.max(0, Math.floor(Number(product.pieces || 0)));
}

function getSizeStock(product: Product, size: string): number {
  const normalizedSize = String(size || '').trim();
  const sizeEntries = normalizeSizeStockEntries(product);
  const match = sizeEntries.find((entry) => String(entry.size || '').trim() === normalizedSize);
  if (match) return Math.max(0, Math.floor(Number(match.left ?? match.stock ?? 0)));
  if (Array.isArray(product.sizeStock) && product.sizeStock.length > 0) return 0;
  return Math.max(0, Math.floor(Number(product.pieces || 0)));
}

function buildEditableSizeStock(product: Product): ProductSizeStock[] {
  if (Array.isArray(product.sizeStock) && product.sizeStock.length > 0) {
    return product.sizeStock.map((entry) => ({
      size: String(entry.size || '').trim(),
      stock: Math.max(0, Math.floor(Number(entry.left ?? entry.stock ?? 0))),
      left: Math.max(0, Math.floor(Number(entry.left ?? entry.stock ?? 0))),
      sold: Math.max(0, Math.floor(Number(entry.sold || 0))),
    })).filter((entry) => entry.size);
  }

  const sizes = Array.isArray(product.sizes) ? product.sizes.filter((size) => String(size || '').trim()) : [];
  const totalStock = Math.max(0, Math.floor(Number(product.initialStock || product.pieces || 0)));
  if (sizes.length === 0) return [];

  return sizes.map((size, index) => ({
    size,
    stock: Math.max(0, Math.floor(totalStock / sizes.length) + (index < (totalStock % sizes.length) ? 1 : 0)),
    left: Math.max(0, Math.floor(totalStock / sizes.length) + (index < (totalStock % sizes.length) ? 1 : 0)),
    sold: 0,
  }));
}

const FlexLogo = ({ className = "h-12" }: { className?: string }) => (
  <img
    src={BRAND_LOGO_SRC}
    alt="Flex Fits"
    className={`${className} w-auto object-contain`}
  />
);

const App: React.FC = () => {
  const currentYear = new Date().getFullYear();
  const initialRoute = typeof window !== 'undefined' ? routeFromPathname(window.location.pathname) : { view: 'home' as View, productId: null };
  const [view, setView] = useState<View>(() =>
    initialRoute.view
  );
  const [selectedProductId, setSelectedProductId] = useState<string | null>(initialRoute.productId);
  const [products, setProducts] = useState<Product[]>([]);
  const [orders, setOrders] = useState<Order[]>([]);
  const [cart, setCart] = useState<CartItem[]>(() => getInitialCartState());
  const [isAdmin, setIsAdmin] = useState(() => {
    // When Supabase is configured, real admin state comes from a Supabase Auth session
    // (resolved asynchronously below) rather than this synchronous localStorage flag, which
    // only backs the dev-only fallback login used when Supabase isn't configured at all.
    if (supabase) return false;
    try {
      return localStorage.getItem(ADMIN_AUTH_STORAGE_KEY) === '1';
    } catch {
      return false;
    }
  });
  const [searchQuery, setSearchQuery] = useState('');
  const deferredSearchQuery = useDeferredValue(searchQuery);
  const [filterCategory, setFilterCategory] = useState<Category | 'All'>('All');
  const [maxPrice, setMaxPrice] = useState<number>(150);
  const [selectedSizeFilters, setSelectedSizeFilters] = useState<string[]>([]);
  const [selectedColorFilters, setSelectedColorFilters] = useState<string[]>([]);
  const [selectedBrands, setSelectedBrands] = useState<string[]>([]);
  const [hideSoldOutItems, setHideSoldOutItems] = useState<boolean>(false);
  const [showOnSaleOnly, setShowOnSaleOnly] = useState<boolean>(false);
  const [selectedGenders, setSelectedGenders] = useState<ProductGender[]>([]);
  const [isCategoryFilterExpanded, setIsCategoryFilterExpanded] = useState<boolean>(true);
  const [isColorFilterExpanded, setIsColorFilterExpanded] = useState<boolean>(true);
  const [isSizeFilterExpanded, setIsSizeFilterExpanded] = useState<boolean>(false);
  const [isGenderFilterExpanded, setIsGenderFilterExpanded] = useState<boolean>(false);
  const [isBrandFilterExpanded, setIsBrandFilterExpanded] = useState<boolean>(false);
  const [isMobileFilterOpen, setIsMobileFilterOpen] = useState<boolean>(false);
  const [mobileFilterPanelOffsetY, setMobileFilterPanelOffsetY] = useState<number>(0);
  const [cartNotice, setCartNotice] = useState<string>('');
  const [imageViewerProduct, setImageViewerProduct] = useState<Product | null>(null);
  const [imageViewerImageIndex, setImageViewerImageIndex] = useState<number>(0);
  const [imageViewerScale, setImageViewerScale] = useState<number>(1);
  const [imageViewerTranslate, setImageViewerTranslate] = useState<{ x: number; y: number }>({ x: 0, y: 0 });
  const mobileFilterGestureRef = useRef({
    isDragging: false,
    startY: 0,
  });
  const preloadedImageUrlsRef = useRef<Set<string>>(new Set());
  const liveRefreshInFlightRef = useRef(false);
  const liveRefreshQueuedRef = useRef(false);
  const imageViewerGestureRef = useRef({
    isPinching: false,
    pinchStartDistance: 0,
    pinchStartScale: 1,
    touchStartX: 0,
    touchStartY: 0,
    lastTouchX: 0,
    lastTouchY: 0,
  });
  const [isLoading, setIsLoading] = useState(true);

  const refreshLiveState = useCallback(async () => {
    if (liveRefreshInFlightRef.current) {
      liveRefreshQueuedRef.current = true;
      return;
    }

    liveRefreshInFlightRef.current = true;
    try {
      const [loadedProducts, loadedOrders] = await Promise.all([
        getProducts(),
        getOrders(),
      ]);
      setProducts(loadedProducts);
      setOrders(loadedOrders);
    } catch (error) {
      console.error('Error refreshing live data:', error);
    } finally {
      liveRefreshInFlightRef.current = false;
      if (liveRefreshQueuedRef.current) {
        liveRefreshQueuedRef.current = false;
        void refreshLiveState();
      }
    }
  }, []);
  
  // Load data from database on mount
  useEffect(() => {
    const loadData = async () => {
      setIsLoading(true);
      try {
        const [loadedProducts, loadedOrders] = await Promise.all([
          getProducts(),
          getOrders()
        ]);
        
        // If no products in database, initialize with default products
        if (loadedProducts.length === 0) {
          // Save initial products to database
          await Promise.all(INITIAL_PRODUCTS.map((product) => saveProduct(product)));
          setProducts(INITIAL_PRODUCTS);
        } else {
          setProducts(loadedProducts);
        }
        
        setOrders(loadedOrders);
      } catch (error) {
        console.error('Error loading data:', error);
        // Fallback to localStorage if database fails
        const savedProducts = localStorage.getItem('flex_products');
        const savedOrders = localStorage.getItem('flex_orders');
        setProducts(savedProducts ? JSON.parse(savedProducts) : INITIAL_PRODUCTS);
        setOrders(savedOrders ? JSON.parse(savedOrders) : []);
      } finally {
        setIsLoading(false);
      }
    };
    
    loadData();
  }, []);

  useEffect(() => {
    if (!supabase) return;
    const client = supabase;

    const channel = client
      .channel('flexfits-live-sync')
      .on('postgres_changes', { event: '*', schema: 'public', table: 'products' }, () => {
        void refreshLiveState();
      })
      .on('postgres_changes', { event: '*', schema: 'public', table: 'stock_reservations' }, () => {
        void refreshLiveState();
      })
      .on('postgres_changes', { event: '*', schema: 'public', table: 'orders' }, () => {
        void refreshLiveState();
      })
      .on('postgres_changes', { event: '*', schema: 'public', table: 'order_items' }, () => {
        void refreshLiveState();
      })
      .subscribe((status) => {
        if (status === 'SUBSCRIBED') {
          void refreshLiveState();
        }
      });

    return () => {
      void client.removeChannel(channel);
    };
  }, [refreshLiveState]);

  // Admin status is derived from a real Supabase Auth session (not just a client-side flag) so
  // that RLS policies can actually trust it. Dev-only fallback (no Supabase configured) keeps
  // using the hardcoded-credential flow inside AdminPanel's login screen below.
  useEffect(() => {
    if (!supabase) return;
    const client = supabase;

    client.auth.getSession().then(({ data }) => {
      setIsAdmin(!!data.session);
    });

    const { data: authListener } = client.auth.onAuthStateChange((_event, session) => {
      setIsAdmin(!!session);
    });

    return () => {
      authListener.subscription.unsubscribe();
    };
  }, []);

  useEffect(() => {
    if (!isAdmin) return;
    void refreshLiveState();
  }, [isAdmin, refreshLiveState]);

  useEffect(() => {
    const syncFromVisibility = () => {
      if (document.visibilityState === 'visible') {
        void refreshLiveState();
      }
    };

    const syncFromFocus = () => {
      void refreshLiveState();
    };

    window.addEventListener('focus', syncFromFocus);
    document.addEventListener('visibilitychange', syncFromVisibility);
    return () => {
      window.removeEventListener('focus', syncFromFocus);
      document.removeEventListener('visibilitychange', syncFromVisibility);
    };
  }, [refreshLiveState]);

  useEffect(() => {
    const timer = window.setInterval(() => {
      void (async () => {
        await cleanupExpiredReservations();
        await refreshLiveState();
      })();
    }, 12000);

    return () => {
      window.clearInterval(timer);
    };
  }, [refreshLiveState]);

  useEffect(() => {
    try {
      localStorage.setItem(CART_STORAGE_KEY, JSON.stringify(cart));
    } catch {
      // Ignore storage issues to avoid interrupting cart flow.
    }
  }, [cart]);

  useEffect(() => {
    // Only the dev-only fallback (no Supabase configured) needs this; with Supabase configured,
    // supabase-js already persists its own session, and isAdmin tracks that session directly.
    if (supabase) return;
    try {
      if (isAdmin) {
        localStorage.setItem(ADMIN_AUTH_STORAGE_KEY, '1');
      } else {
        localStorage.removeItem(ADMIN_AUTH_STORAGE_KEY);
      }
    } catch {
      // Ignore storage errors to avoid interrupting admin flow.
    }
  }, [isAdmin]);

  useEffect(() => {
    if (cartNotice.trim() === '') return;
    const timeout = window.setTimeout(() => setCartNotice(''), 4800);
    return () => window.clearTimeout(timeout);
  }, [cartNotice]);

  useEffect(() => {
    if (products.length === 0 || cart.length === 0) return;

    const productById = new Map(products.map((product) => [product.Product_ID, product]));
    setCart((prev) => {
      let changed = false;
      const next = prev
        .map((line) => {
          const latest = productById.get(line.Product_ID);
          if (!latest) {
            changed = true;
            return null;
          }
          return {
            ...(latest as Product),
            quantity: line.quantity,
            selectedSize: line.selectedSize,
            reservationId: line.reservationId,
            reservedAt: line.reservedAt,
            expiresAt: line.expiresAt,
          } as CartItem;
        })
        .filter(Boolean) as CartItem[];

      return changed ? next : prev;
    });
  }, [products]);

  useEffect(() => {
    const syncFromUrl = () => {
      const nextRoute = routeFromPathname(window.location.pathname);
      setView(nextRoute.view);
      setSelectedProductId(nextRoute.productId);
    };

    syncFromUrl();
    window.addEventListener('popstate', syncFromUrl);
    return () => window.removeEventListener('popstate', syncFromUrl);
  }, []);

  useEffect(() => {
    const targetPath = pathnameFromRoute(view, selectedProductId);
    if (window.location.pathname !== targetPath) {
      window.history.pushState({}, '', targetPath);
    }
  }, [view, selectedProductId]);

  useEffect(() => {
    if (!isMobileFilterOpen && !imageViewerProduct) return;

    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key === 'Escape') {
        setIsMobileFilterOpen(false);
        closeImageViewer();
      }
    };

    document.body.style.overflow = 'hidden';
    window.addEventListener('keydown', onKeyDown);

    return () => {
      document.body.style.overflow = '';
      window.removeEventListener('keydown', onKeyDown);
    };
  }, [isMobileFilterOpen, imageViewerProduct]);

  useEffect(() => {
    if (!isMobileFilterOpen) {
      setMobileFilterPanelOffsetY(0);
      mobileFilterGestureRef.current = { isDragging: false, startY: 0 };
    }
  }, [isMobileFilterOpen]);

  useEffect(() => {
    if (cart.length === 0) return;

    const removeExpiredLines = async () => {
      const nowMs = Date.now();
      const expired = cart.filter((item) => {
        const exp = item.expiresAt ? new Date(item.expiresAt).getTime() : 0;
        return exp > 0 && exp <= nowMs;
      });

      if (expired.length === 0) return;

      const expiredKeys = new Set(expired.map((item) => `${item.Product_ID}::${item.selectedSize}::${item.reservationId || ''}`));

      setCart((prev) => prev.filter((item) => !expiredKeys.has(`${item.Product_ID}::${item.selectedSize}::${item.reservationId || ''}`)));
      setCartNotice(`${expired.length} item${expired.length > 1 ? 's were' : ' was'} removed due to timeout.`);

      for (const item of expired) {
        await releaseCartLineReservation(item.reservationId);
      }
      await cleanupExpiredReservations();

    };

    void removeExpiredLines();

    const nextExpiryMs = cart
      .map((item) => (item.expiresAt ? new Date(item.expiresAt).getTime() : 0))
      .filter((value) => value > 0)
      .sort((a, b) => a - b)[0];

    if (!nextExpiryMs) {
      return;
    }

    const timeoutMs = Math.max(200, nextExpiryMs - Date.now() + 40);
    const timeout = window.setTimeout(() => {
      void removeExpiredLines();
    }, timeoutMs);

    return () => {
      window.clearTimeout(timeout);
    };
  }, [cart]);
  
  // Sync products to database when they change (for admin operations)
  const syncProductToDatabase = async (product: Product) => {
    try {
      await saveProduct(product);
    } catch (error) {
      console.error('Error saving product to database:', error);
      // Do not silently fallback for admin writes; surface the failure.
      throw error;
    }
  };
  
  // Sync orders to database when they change
  const syncOrderToDatabase = async (order: Order) => {
    try {
      await saveOrder(order);
    } catch (error) {
      console.error('Error saving order to database:', error);
      throw error;
    }
  };

  const filterOptions = useMemo(() => {
    const brands = new Set<string>();
    const colors = new Set<string>();

    for (const p of products) {
      const brand = getProductBrandLabel(p);
      if (brand) brands.add(brand);
      for (const c of getProductColorTokens(p)) {
        colors.add(c);
      }
    }

    return {
      brands: Array.from(brands).sort((a, b) => a.localeCompare(b, undefined, { sensitivity: 'base' })),
      colors: Array.from(colors).sort((a, b) => a.localeCompare(b, undefined, { sensitivity: 'base' })),
    };
  }, [products]);

  const filteredProducts = useMemo(() => {
    const q = deferredSearchQuery.trim().toLowerCase();
    return products.filter(p => {
      if (!isProductVisibleToCustomer(p)) return false;
      const availabilityState = getProductAvailabilityState(p);
      const isSoldOut = availabilityState === 'unavailable';
      const productGender = normalizeGender(p.gender);

      const colorTokens = getProductColorTokens(p);
      const brandLabel = getProductBrandLabel(p);
      const matchesSearch =
        !q ||
        (p.productName || p.name).toLowerCase().includes(q) ||
        brandLabel.toLowerCase().includes(q) ||
        String(p.category || '').toLowerCase().includes(q) ||
        String(p.type || '').toLowerCase().includes(q) ||
        colorTokens.some((c) => c.includes(q));
      const matchesPrice = p.price <= maxPrice;
      const matchesSize = productMatchesSelectedSizes(p.sizes || [], selectedSizeFilters);
      const matchesGender = selectedGenders.length === 0 || selectedGenders.includes(productGender);
      const matchesColors =
        selectedColorFilters.length === 0 ||
        selectedColorFilters.some((c) => colorTokens.includes(c));
      const matchesBrand =
        selectedBrands.length === 0 ||
        selectedBrands.includes(getProductBrandLabel(p));

      const matchesCategory = filterCategory === 'All' || p.category === filterCategory;
      return matchesSearch && matchesColors && matchesCategory && matchesPrice && matchesSize && matchesGender && matchesBrand && !(hideSoldOutItems && isSoldOut) && !(showOnSaleOnly && !p.onSale);
    });
  }, [products, deferredSearchQuery, filterCategory, maxPrice, selectedSizeFilters, selectedGenders, selectedColorFilters, selectedBrands, hideSoldOutItems, showOnSaleOnly]);

  const activeProduct = useMemo(
    () => products.find((product) => product.Product_ID === selectedProductId) || null,
    [products, selectedProductId]
  );
  const activeProductImages = activeProduct ? getProductImages(activeProduct) : [];
  const [productDetailSelectedSize, setProductDetailSelectedSize] = useState('');
  const [productDetailSelectedImageIndex, setProductDetailSelectedImageIndex] = useState(0);
  const [productDetailQuantity, setProductDetailQuantity] = useState(1);
  const productGalleryManualPauseUntilRef = useRef<number>(0);

  useEffect(() => {
    setProductDetailSelectedSize('');
    setProductDetailSelectedImageIndex(0);
    setProductDetailQuantity(1);
    productGalleryManualPauseUntilRef.current = 0;
  }, [selectedProductId]);

  useEffect(() => {
    if (view !== 'product' || !activeProduct || activeProductImages.length <= 1) return;
    const timer = window.setInterval(() => {
      if (Date.now() < productGalleryManualPauseUntilRef.current) return;
      setProductDetailSelectedImageIndex((prev) => (prev + 1) % activeProductImages.length);
    }, 2500);
    return () => window.clearInterval(timer);
  }, [view, activeProduct, activeProductImages]);

  useEffect(() => {
    if (!activeProduct) return;
    const maxStock = productDetailSelectedSize ? getSizeStock(activeProduct, productDetailSelectedSize) : 1;
    setProductDetailQuantity((prev) => Math.max(1, Math.min(prev, Math.max(1, maxStock))));
  }, [activeProduct, productDetailSelectedSize]);

  useEffect(() => {
    if (view !== 'shop') return;
    const topImages = filteredProducts
      .slice(0, 8)
      .map((p) => getProductImages(p)[0])
      .filter(Boolean) as string[];

    const links: HTMLLinkElement[] = [];
    for (const src of topImages) {
      const normalizedSrc = String(src || '').trim();
      if (!normalizedSrc) continue;
      if (/^data:/i.test(normalizedSrc)) continue;
      if (!/^https?:\/\//i.test(normalizedSrc) && !/^\//.test(normalizedSrc)) continue;
      if (preloadedImageUrlsRef.current.has(normalizedSrc)) continue;
      const link = document.createElement('link');
      link.rel = 'preload';
      link.as = 'image';
      link.href = normalizedSrc;
      document.head.appendChild(link);
      links.push(link);
      preloadedImageUrlsRef.current.add(normalizedSrc);
    }

    return () => {
      for (const link of links) {
        if (link.parentNode) link.parentNode.removeChild(link);
      }
      preloadedImageUrlsRef.current.clear();
    };
  }, [view, filteredProducts]);

  const cartTotal = cart.reduce((acc, item) => acc + item.price * item.quantity, 0);
  const checkoutTotal = cart.length > 0 ? cartTotal + DELIVERY_FEE : 0;

  const addToCart = async (product: Product, size: string, quantityToAdd: number = 1): Promise<boolean> => {
    const requestedQty = Math.max(1, Math.floor(Number(quantityToAdd || 1)));
    const liveProduct = products.find(p => p.Product_ID === product.Product_ID);
    const liveAvailabilityState = liveProduct ? getProductAvailabilityState(liveProduct) : 'unavailable';
    if (!liveProduct) {
      alert('This product is currently unavailable.');
      return false;
    }
    if (liveAvailabilityState === 'reserved') {
      alert('This product is currently reserved by another customer.');
      return false;
    }
    if (liveAvailabilityState !== 'available') {
      alert('This product is currently unavailable.');
      return false;
    }
    const liveTotalStock = getTotalSizeStock(liveProduct);
    if (liveTotalStock <= 0) {
      alert("This item is currently out of stock!");
      return false;
    }

    const liveSizeStock = getSizeStock(liveProduct, size);
    if (liveSizeStock <= 0) {
      const sizeCommittedAvailable = getCommittedAvailableForSize(liveProduct, size);
      if (sizeCommittedAvailable > 0) {
        alert('This product is currently reserved by another customer.');
        return false;
      }
      alert('That size is currently out of stock!');
      return false;
    }

    if (requestedQty > liveSizeStock) {
      alert(`Only ${liveSizeStock} item(s) left for size ${size}.`);
      return false;
    }

    const existing = cart.find(i => i.Product_ID === product.Product_ID && i.selectedSize === size);
    const nextQuantity = existing ? existing.quantity + requestedQty : requestedQty;

    let reservation = await reserveCartLine({
      productId: product.Product_ID,
      size,
      quantity: requestedQty,
      existingReservationId: existing?.reservationId,
    });

    if ((!reservation.ok || !reservation.reservationId) && existing?.reservationId) {
      // If previous reservation id is stale, retry as fresh reservation for this line quantity.
      reservation = await reserveCartLine({
        productId: product.Product_ID,
        size,
        quantity: nextQuantity,
      });
    }

    if (!reservation.ok || !reservation.reservationId || !reservation.expiresAt) {
      try {
        const refreshedProducts = await getProducts();
        setProducts(refreshedProducts);
      } catch {
        // Keep UX resilient even if refresh fails.
      }

      if (reservation.reason === 'size_out_of_stock') {
        alert(`Size ${size} is currently out of stock.`);
      } else if (reservation.reason === 'reserved_by_others') {
        const cappedAvailable = Math.max(0, Number(reservation.availableAfter || 0));
        alert(cappedAvailable > 0
          ? `Only ${cappedAvailable} item(s) are currently available for size ${size}.`
          : 'This item is currently reserved by another shopper. Please try again shortly.');
      } else {
        alert(reservation.message || 'Unable to reserve this item right now. Please retry.');
      }
      return false;
    }

    setCartNotice('');
    setCart(prev => {
      const existingIndex = prev.findIndex(i => i.Product_ID === product.Product_ID && i.selectedSize === size);
      if (existingIndex >= 0) {
        const updated = [...prev];
        updated[existingIndex] = {
          ...updated[existingIndex],
          quantity: nextQuantity,
          reservationId: reservation.reservationId,
          reservedAt: new Date().toISOString(),
          expiresAt: reservation.expiresAt,
        };
        return updated;
      }
      return [...prev, {
        ...product,
        Product_ID: product.Product_ID,
        quantity: requestedQty,
        selectedSize: size,
        reservationId: reservation.reservationId,
        reservedAt: new Date().toISOString(),
        expiresAt: reservation.expiresAt,
      }];
    });

    setProducts(prev => prev.map((p) => {
      if (p.Product_ID !== product.Product_ID) return p;
      const currentSizeStock = normalizeSizeStockEntries(p);
      const nextSizeStock = currentSizeStock.length > 0
        ? currentSizeStock.map((entry) => entry.size === size ? { ...entry, left: Math.max(0, entry.left - requestedQty) } : entry)
        : currentSizeStock;
      const nextPiecesBySize = nextSizeStock.reduce((total, entry) => total + Math.max(0, Number(entry.left || 0)), 0);
      if (reservation.availableAfter !== undefined) {
        return { ...p, pieces: Math.max(0, Number(nextPiecesBySize || reservation.availableAfter || 0)), sizeStock: nextSizeStock.length > 0 ? nextSizeStock : p.sizeStock };
      }
      return { ...p, pieces: Math.max(0, Number(nextPiecesBySize || 0)), sizeStock: nextSizeStock.length > 0 ? nextSizeStock : p.sizeStock };
    }));
    return true;
  };

  const openProductPage = (product: Product) => {
    setSelectedProductId(product.Product_ID);
    setView('product');
    window.scrollTo(0, 0);
  };

  const closeImageViewer = () => {
    setImageViewerProduct(null);
    setImageViewerImageIndex(0);
    setImageViewerScale(1);
    setImageViewerTranslate({ x: 0, y: 0 });
    imageViewerGestureRef.current = {
      isPinching: false,
      pinchStartDistance: 0,
      pinchStartScale: 1,
      touchStartX: 0,
      touchStartY: 0,
      lastTouchX: 0,
      lastTouchY: 0,
    };
  };

  const openImageViewer = (product: Product, startIndex: number = 0) => {
    const imageCount = getProductImages(product).length;
    const normalizedStart = imageCount > 0
      ? Math.max(0, Math.min(startIndex, imageCount - 1))
      : 0;
    setImageViewerProduct(product);
    setImageViewerImageIndex(normalizedStart);
    setImageViewerScale(1);
    setImageViewerTranslate({ x: 0, y: 0 });
  };

  const imageViewerImages = useMemo(
    () => (imageViewerProduct ? getProductImages(imageViewerProduct) : []),
    [imageViewerProduct]
  );

  const imageViewerActiveSrc = imageViewerProduct
    ? (imageViewerImages[imageViewerImageIndex] || imageViewerProduct.image || '/flex-logo-bbg.JPG')
    : '';

  const stepImageViewer = useCallback((step: number) => {
    setImageViewerImageIndex((prev) => {
      if (imageViewerImages.length <= 1) return 0;
      const next = prev + step;
      if (next < 0) return imageViewerImages.length - 1;
      if (next >= imageViewerImages.length) return 0;
      return next;
    });
    setImageViewerScale(1);
    setImageViewerTranslate({ x: 0, y: 0 });
  }, [imageViewerImages.length]);

  const handleMobileFilterTouchStart = (event: React.TouchEvent<HTMLDivElement>) => {
    const firstTouch = event.touches[0];
    if (!firstTouch) return;
    mobileFilterGestureRef.current = {
      isDragging: true,
      startY: firstTouch.clientY,
    };
  };

  const handleMobileFilterTouchMove = (event: React.TouchEvent<HTMLDivElement>) => {
    if (!mobileFilterGestureRef.current.isDragging) return;
    const firstTouch = event.touches[0];
    if (!firstTouch) return;
    const deltaY = Math.max(0, firstTouch.clientY - mobileFilterGestureRef.current.startY);
    setMobileFilterPanelOffsetY(Math.min(deltaY, 260));
    if (event.cancelable && deltaY > 0) {
      event.preventDefault();
    }
  };

  const handleMobileFilterTouchEnd = () => {
    const shouldClose = mobileFilterPanelOffsetY > 90;
    mobileFilterGestureRef.current = {
      isDragging: false,
      startY: 0,
    };
    if (shouldClose) {
      setIsMobileFilterOpen(false);
      return;
    }
    setMobileFilterPanelOffsetY(0);
  };

  const clampScale = (value: number) => Math.min(4, Math.max(1, value));

  const handleImageViewerWheel = (event: React.WheelEvent<HTMLDivElement>) => {
    event.preventDefault();
    setImageViewerScale((prev) => {
      const nextScale = clampScale(prev - event.deltaY * 0.0022);
      if (nextScale === 1) setImageViewerTranslate({ x: 0, y: 0 });
      return nextScale;
    });
  };

  const getTouchDistance = (touches: React.TouchList): number => {
    if (touches.length < 2) return 0;
    const dx = touches[0].clientX - touches[1].clientX;
    const dy = touches[0].clientY - touches[1].clientY;
    return Math.hypot(dx, dy);
  };

  const handleImageViewerTouchStart = (event: React.TouchEvent<HTMLDivElement>) => {
    const gesture = imageViewerGestureRef.current;
    if (event.touches.length >= 2) {
      gesture.isPinching = true;
      gesture.pinchStartDistance = getTouchDistance(event.touches);
      gesture.pinchStartScale = imageViewerScale;
      return;
    }

    const firstTouch = event.touches[0];
    if (!firstTouch) return;
    gesture.isPinching = false;
    gesture.touchStartX = firstTouch.clientX;
    gesture.touchStartY = firstTouch.clientY;
    gesture.lastTouchX = firstTouch.clientX;
    gesture.lastTouchY = firstTouch.clientY;
  };

  const handleImageViewerTouchMove = (event: React.TouchEvent<HTMLDivElement>) => {
    const gesture = imageViewerGestureRef.current;

    const stopDefaultIfPossible = () => {
      if (event.cancelable) {
        event.preventDefault();
      }
    };

    if (event.touches.length >= 2) {
      stopDefaultIfPossible();
      const distance = getTouchDistance(event.touches);
      if (!gesture.pinchStartDistance) {
        gesture.pinchStartDistance = distance;
        gesture.pinchStartScale = imageViewerScale;
      }

      const ratio = distance / Math.max(gesture.pinchStartDistance, 1);
      const nextScale = clampScale(gesture.pinchStartScale * ratio);
      setImageViewerScale(nextScale);
      if (nextScale === 1) setImageViewerTranslate({ x: 0, y: 0 });
      return;
    }

    const firstTouch = event.touches[0];
    if (!firstTouch) return;

    const deltaX = firstTouch.clientX - gesture.lastTouchX;
    const deltaY = firstTouch.clientY - gesture.lastTouchY;

    if (imageViewerScale > 1.02) {
      stopDefaultIfPossible();
      setImageViewerTranslate((prev) => ({ x: prev.x + deltaX, y: prev.y + deltaY }));
    }

    gesture.lastTouchX = firstTouch.clientX;
    gesture.lastTouchY = firstTouch.clientY;
  };

  const handleImageViewerTouchEnd = (event: React.TouchEvent<HTMLDivElement>) => {
    const gesture = imageViewerGestureRef.current;
    if (event.touches.length >= 2) {
      gesture.pinchStartDistance = getTouchDistance(event.touches);
      gesture.pinchStartScale = imageViewerScale;
      return;
    }

    if (event.touches.length === 1) {
      gesture.isPinching = false;
      const firstTouch = event.touches[0];
      gesture.lastTouchX = firstTouch.clientX;
      gesture.lastTouchY = firstTouch.clientY;
      return;
    }

    const endingTouch = event.changedTouches[0];
    if (endingTouch && imageViewerScale <= 1.05) {
      const swipeX = endingTouch.clientX - gesture.touchStartX;
      const swipeY = endingTouch.clientY - gesture.touchStartY;
      const isHorizontalGallerySwipe = imageViewerImages.length > 1 && Math.abs(swipeX) > 70 && Math.abs(swipeX) > Math.abs(swipeY) * 1.1;
      if (isHorizontalGallerySwipe) {
        stepImageViewer(swipeX < 0 ? 1 : -1);
        return;
      }
      const isVerticalDismiss = Math.abs(swipeY) > 90 && Math.abs(swipeY) > Math.abs(swipeX) * 1.2;
      if (isVerticalDismiss) {
        closeImageViewer();
        return;
      }
    }

    if (imageViewerScale <= 1.02) {
      setImageViewerScale(1);
      setImageViewerTranslate({ x: 0, y: 0 });
    }

    gesture.isPinching = false;
    gesture.pinchStartDistance = 0;
  };

  const removeFromCart = async (productId: string, size: string) => {
    const line = cart.find((item) => item.Product_ID === productId && item.selectedSize === size);
    await releaseCartLineReservation(line?.reservationId);
    setCart(prev => prev.filter(i => !(i.Product_ID === productId && i.selectedSize === size)));

    if (!line) return;
    const releasedQty = Math.max(0, Number(line.quantity || 0));
    if (releasedQty <= 0) return;

    setProducts((prev) => prev.map((product) => {
      if (product.Product_ID !== productId) return product;

      const normalizedSize = String(size || '').trim();
      const sizeStock = normalizeSizeStockEntries(product);
      const nextSizeStock = sizeStock.length > 0
        ? sizeStock.map((entry) => (
            String(entry.size || '').trim() === normalizedSize
              ? { ...entry, left: Math.max(0, entry.left + releasedQty) }
              : entry
          ))
        : product.sizeStock;
      const nextPiecesBySize = Array.isArray(nextSizeStock)
        ? nextSizeStock.reduce((total, entry) => total + Math.max(0, Number(entry.left || 0)), 0)
        : Math.max(0, Number(product.pieces || 0) + releasedQty);

      return {
        ...product,
        pieces: Math.max(0, Number(nextPiecesBySize || 0)),
        sizeStock: nextSizeStock,
      };
    }));
  };

  const getRemainingMs = (item: CartItem, nowMs: number): number => {
    const expMs = item.expiresAt ? new Date(item.expiresAt).getTime() : 0;
    if (!expMs) return 0;
    return Math.max(0, expMs - nowMs);
  };

  const formatRemaining = (ms: number): string => {
    const totalSeconds = Math.max(0, Math.floor(ms / 1000));
    const min = Math.floor(totalSeconds / 60).toString().padStart(2, '0');
    const sec = Math.floor(totalSeconds % 60).toString().padStart(2, '0');
    return `${min}:${sec}`;
  };

  const toggleGenderFilter = useCallback((genderOption: ProductGender, isEnabled: boolean) => {
    setSelectedGenders((prev) => {
      if (isEnabled) {
        if (prev.includes(genderOption)) return prev;
        return [...prev, genderOption];
      }
      return prev.filter((g) => g !== genderOption);
    });
  }, []);

  const toggleSizeFilter = useCallback((sizeOption: string, isEnabled: boolean) => {
    const normalized = String(sizeOption || '').trim().toUpperCase();
    if (!normalized) return;
    setSelectedSizeFilters((prev) => {
      if (isEnabled) {
        if (prev.includes(normalized)) return prev;
        return [...prev, normalized];
      }
      return prev.filter((entry) => entry !== normalized);
    });
  }, []);

  const toggleColorFilter = useCallback((token: string, isEnabled: boolean) => {
    const normalized = String(token || '').trim().toLowerCase();
    if (!normalized) return;
    setSelectedColorFilters((prev) => {
      if (isEnabled) {
        if (prev.includes(normalized)) return prev;
        return [...prev, normalized];
      }
      return prev.filter((c) => c !== normalized);
    });
  }, []);

  const toggleBrandFilter = useCallback((brand: string, isEnabled: boolean) => {
    const normalized = String(brand || '').trim();
    if (!normalized) return;
    setSelectedBrands((prev) => {
      if (isEnabled) {
        if (prev.includes(normalized)) return prev;
        return [...prev, normalized];
      }
      return prev.filter((entry) => entry !== normalized);
    });
  }, []);

  const renderFilterControls = () => (
    <>
      <div className="mb-4 p-3 bg-orange-50 border border-orange-100 rounded-xl">
        <p className="text-[9px] font-black uppercase tracking-[0.18em] mb-1 text-orange-600 italic">Trusted Sneaker Supplier</p>
        <p className="text-[10px] font-semibold leading-snug text-gray-700">Every product is guaranteed 100% original. Authentic or your money back.</p>
      </div>
      <div className="mb-4 border rounded-2xl bg-white overflow-hidden">
        <button type="button" onClick={() => setIsCategoryFilterExpanded((prev) => !prev)} className="w-full px-3 py-3 flex items-center justify-between">
          <h3 className="font-black text-[10px] uppercase tracking-[0.35em] text-gray-300 italic">Categories</h3>
          <ChevronRight size={14} className={`text-gray-400 transition-transform ${isCategoryFilterExpanded ? 'rotate-90' : ''}`} />
        </button>
        {isCategoryFilterExpanded && (
          <div className="px-3 pb-3 space-y-2">
            {['All', ...Object.values(Category)].map(c => (
              <button key={c} onClick={() => setFilterCategory(c as Category | 'All')} className={`block w-full text-left p-3 rounded-xl text-[10px] transition-all uppercase font-black italic tracking-[0.12em] ${filterCategory === c ? 'bg-black text-white shadow-xl border-2 border-black' : 'hover:bg-gray-50 text-gray-400 border-2 border-transparent'}`}>
                {c} Selection
              </button>
            ))}
          </div>
        )}
      </div>
      <div className="pt-4 border-t-2 border-gray-50">
        <h3 className="font-black text-[10px] uppercase tracking-[0.35em] mb-4 text-gray-300 italic">Price Filter</h3>
        <div className="px-2">
          <input type="range" min="0" max="150" step="5" value={maxPrice} onChange={(e) => setMaxPrice(Number(e.target.value))} className="w-full h-1.5 bg-gray-100 rounded-lg appearance-none cursor-pointer accent-orange-600" />
          <div className="flex justify-between mt-4 font-black text-[9px] tracking-wider italic uppercase">
            <span className="text-gray-300">Min: $0</span>
            <span className="text-orange-600 text-[11px]">Max: ${maxPrice}</span>
          </div>
        </div>
      </div>
      <div className="pt-4 border-t-2 border-gray-50 space-y-2">
        <button type="button" onClick={() => setIsSizeFilterExpanded((prev) => !prev)} className="w-full flex items-center justify-between">
          <h3 className="font-black text-[10px] uppercase tracking-[0.35em] text-gray-300 italic">Size Filter</h3>
          <span className="flex items-center gap-2">
            {selectedSizeFilters.length > 0 && (
              <span className="text-[8px] font-black uppercase px-1.5 py-0.5 rounded bg-orange-100 text-orange-700">
                {selectedSizeFilters.length}
              </span>
            )}
            <ChevronRight size={14} className={`text-gray-400 transition-transform ${isSizeFilterExpanded ? 'rotate-90' : ''}`} />
          </span>
        </button>
        {isSizeFilterExpanded && (
          <div className="p-2.5 border rounded-xl bg-white space-y-3">
            <div>
              <p className="text-[9px] font-black uppercase tracking-wider text-gray-400 mb-2">Numeric Sizes</p>
              <div className="grid grid-cols-4 gap-1.5">
                {NUMERIC_SIZE_FILTER_OPTIONS.map((sizeOption) => (
                  <label key={sizeOption} className="flex items-center gap-1.5 text-[9px] font-black uppercase tracking-wider cursor-pointer">
                    <input
                      type="checkbox"
                      checked={selectedSizeFilters.includes(sizeOption)}
                      onChange={(e) => toggleSizeFilter(sizeOption, e.target.checked)}
                      className="h-3.5 w-3.5 accent-orange-600"
                    />
                    <span>{sizeOption}</span>
                  </label>
                ))}
              </div>
            </div>
            <div className="pt-2 border-t border-gray-100">
              <p className="text-[9px] font-black uppercase tracking-wider text-gray-400 mb-2">Clothing Sizes</p>
              <div className="grid grid-cols-4 gap-1.5">
                {CLOTHING_SIZE_FILTER_OPTIONS.map((sizeOption) => (
                  <label key={sizeOption} className="flex items-center gap-1.5 text-[9px] font-black uppercase tracking-wider cursor-pointer">
                    <input
                      type="checkbox"
                      checked={selectedSizeFilters.includes(sizeOption)}
                      onChange={(e) => toggleSizeFilter(sizeOption, e.target.checked)}
                      className="h-3.5 w-3.5 accent-orange-600"
                    />
                    <span>{sizeOption}</span>
                  </label>
                ))}
              </div>
            </div>
          </div>
        )}
      </div>
      <div className="pt-4 border-t-2 border-gray-50 space-y-2">
        <button type="button" onClick={() => setIsColorFilterExpanded((prev) => !prev)} className="w-full flex items-center justify-between">
          <h3 className="font-black text-[10px] uppercase tracking-[0.35em] text-gray-300 italic">Colors</h3>
          <span className="flex items-center gap-2">
            {selectedColorFilters.length > 0 && (
              <span className="text-[8px] font-black uppercase px-1.5 py-0.5 rounded bg-orange-100 text-orange-700">
                {selectedColorFilters.length}
              </span>
            )}
            <ChevronRight size={14} className={`text-gray-400 transition-transform ${isColorFilterExpanded ? 'rotate-90' : ''}`} />
          </span>
        </button>
        {isColorFilterExpanded && (
          <>
            <p className="text-[9px] text-gray-400 font-semibold">Tap colors (from your catalog)</p>
            <div className="flex flex-wrap gap-1.5 max-h-40 overflow-y-auto p-1">
              {filterOptions.colors.length === 0 ? (
                <span className="text-[9px] text-gray-400 italic">No colors yet — add products with colors in admin.</span>
              ) : (
                filterOptions.colors.map((c) => (
                  <button
                    key={c}
                    type="button"
                    onClick={() => toggleColorFilter(c, !selectedColorFilters.includes(c))}
                    className={`text-[9px] font-black uppercase px-2 py-1 rounded-full border transition-all ${
                      selectedColorFilters.includes(c)
                        ? 'bg-orange-600 text-white border-orange-600'
                        : 'bg-white text-gray-600 border-gray-200 hover:border-orange-400'
                    }`}
                  >
                    {c}
                  </button>
                ))
              )}
            </div>
          </>
        )}
      </div>
      <div className="pt-4 border-t-2 border-gray-50 space-y-2">
        <button type="button" onClick={() => setIsGenderFilterExpanded((prev) => !prev)} className="w-full flex items-center justify-between">
          <h3 className="font-black text-[10px] uppercase tracking-[0.35em] text-gray-300 italic">Gender Filter</h3>
          <span className="flex items-center gap-2">
            {selectedGenders.length > 0 && (
              <span className="text-[8px] font-black uppercase px-1.5 py-0.5 rounded bg-orange-100 text-orange-700">
                {selectedGenders.length}
              </span>
            )}
            <ChevronRight size={14} className={`text-gray-400 transition-transform ${isGenderFilterExpanded ? 'rotate-90' : ''}`} />
          </span>
        </button>
        {isGenderFilterExpanded && (
          <div className="space-y-1.5 p-2.5 border rounded-xl bg-white">
            {GENDER_OPTIONS.map((genderOption) => (
              <label key={genderOption} className="flex items-center gap-2.5 text-[9px] font-black uppercase tracking-wider cursor-pointer">
                <input
                  type="checkbox"
                  checked={selectedGenders.includes(genderOption)}
                  onChange={(e) => toggleGenderFilter(genderOption, e.target.checked)}
                  className="h-3.5 w-3.5 accent-orange-600"
                />
                <span>{genderOption}</span>
              </label>
            ))}
          </div>
        )}
      </div>
      <div className="pt-4 border-t-2 border-gray-50 space-y-2">
        <button type="button" onClick={() => setIsBrandFilterExpanded((prev) => !prev)} className="w-full flex items-center justify-between">
          <h3 className="font-black text-[10px] uppercase tracking-[0.35em] text-gray-300 italic">Choose Brand</h3>
          <span className="flex items-center gap-2">
            {selectedBrands.length > 0 && (
              <span className="text-[8px] font-black uppercase px-1.5 py-0.5 rounded bg-orange-100 text-orange-700">
                {selectedBrands.length}
              </span>
            )}
            <ChevronRight size={14} className={`text-gray-400 transition-transform ${isBrandFilterExpanded ? 'rotate-90' : ''}`} />
          </span>
        </button>
        {isBrandFilterExpanded && (
          <div className="space-y-1.5 p-2.5 border rounded-xl bg-white max-h-44 overflow-y-auto">
            {filterOptions.brands.length === 0 ? (
              <p className="text-[9px] text-gray-400 italic">No brands found in catalog yet.</p>
            ) : (
              filterOptions.brands.map((brandOption) => (
                <label key={brandOption} className="flex items-center gap-2.5 text-[9px] font-black uppercase tracking-wider cursor-pointer">
                  <input
                    type="checkbox"
                    checked={selectedBrands.includes(brandOption)}
                    onChange={(e) => toggleBrandFilter(brandOption, e.target.checked)}
                    className="h-3.5 w-3.5 accent-orange-600"
                  />
                  <span>{brandOption}</span>
                </label>
              ))
            )}
          </div>
        )}
      </div>
      <div className="pt-4 border-t-2 border-gray-50 space-y-2">
        <label className="flex items-center gap-2.5 p-2.5 border rounded-xl bg-white text-[9px] font-black uppercase tracking-wider cursor-pointer">
          <input
            type="checkbox"
            checked={hideSoldOutItems}
            onChange={(e) => setHideSoldOutItems(e.target.checked)}
            className="h-3.5 w-3.5 accent-orange-600"
          />
          <span>Hide Sold Out Items</span>
        </label>
        <label className="flex items-center gap-2.5 p-2.5 border rounded-xl bg-white text-[9px] font-black uppercase tracking-wider cursor-pointer">
          <input
            type="checkbox"
            checked={showOnSaleOnly}
            onChange={(e) => setShowOnSaleOnly(e.target.checked)}
            className="h-3.5 w-3.5 accent-orange-600"
          />
          <span>Sale Items Only</span>
        </label>
      </div>
    </>
  );


  const Footer = () => (
    <footer className="bg-black text-white pt-12 pb-6 mt-16 border-t-2 border-orange-600 overflow-hidden">
      <div className="max-w-7xl mx-auto px-4">
        <div className="grid grid-cols-1 md:grid-cols-3 gap-8 mb-8">
          <div className="space-y-4">
            <div onClick={() => {setView('home'); window.scrollTo(0,0);}} className="cursor-pointer group">
              <img
                src="/flex-logo-bbg.JPG"
                alt="Flex Fits"
                className="h-12 w-auto object-contain group-hover:scale-110 transition-transform"
              />
            </div>
            <p className="text-gray-500 text-xs font-medium leading-relaxed max-w-sm italic">
              Premium apparel and curated footwear for those who demand uncompromising originality. Every item in our catalog is 100% verified authentic. Trusted across Lebanon.
            </p>
            <div className="flex items-center gap-2 text-[9px] font-black uppercase tracking-widest text-orange-500 italic bg-white/5 w-fit px-4 py-2 rounded-xl border border-white/5">
               <span className="w-2 h-2 bg-green-500 rounded-full animate-pulse"></span> Service Fully Operational 🇱🇧
            </div>
          </div>
          <div className="grid grid-cols-2 gap-6 pt-2">
            <div className="space-y-4">
              <h4 className="font-black text-[10px] uppercase tracking-[0.4em] text-gray-600 italic">Curations</h4>
              <div className="space-y-2">
                {Object.values(Category).map(c => (
                  <button key={c} onClick={() => {setFilterCategory(c); setView('shop'); window.scrollTo(0,0);}} className="block text-xs text-gray-400 hover:text-orange-600 transition-all text-left uppercase font-black italic tracking-tighter hover:translate-x-2">{c}</button>
                ))}
              </div>
            </div>
            <div className="space-y-4">
              <h4 className="font-black text-[10px] uppercase tracking-[0.4em] text-gray-600 italic">Storefront</h4>
              <div className="space-y-2">
                <button onClick={() => {setView('cart'); window.scrollTo(0,0);}} className="block text-xs text-gray-400 hover:text-orange-600 transition-all uppercase font-black italic tracking-tighter hover:translate-x-2">Bag</button>
                <button onClick={() => {setFilterCategory('All'); setView('shop'); window.scrollTo(0,0);}} className="block text-xs text-gray-400 hover:text-orange-600 transition-all uppercase font-black italic tracking-tighter hover:translate-x-2">Full Collection</button>
              </div>
            </div>
          </div>
          <div className="space-y-4 pt-2">
            <h4 className="font-black text-[10px] uppercase tracking-[0.4em] text-gray-600 italic">Secure Channels</h4>
            <div className="space-y-3">
              <a href="https://www.instagram.com/flexfits.lb?igsh=enR0eHhuOWdxMWdx" target="_blank" rel="noreferrer" className="text-base font-black italic flex items-center gap-3 text-white hover:text-orange-500 transition-all group">
                INSTAGRAM <div className="p-2 bg-white/5 group-hover:bg-orange-600 rounded-xl transition-all"><ExternalLink size={18} className="text-orange-600 group-hover:text-white" /></div>
              </a>
              <a href="https://t.me/flexfitsbot" target="_blank" rel="noreferrer" className="text-base font-black italic flex items-center gap-3 text-white hover:text-orange-500 transition-all group">
                TELEGRAM BOT <div className="p-2 bg-white/5 group-hover:bg-orange-600 rounded-xl transition-all"><ExternalLink size={18} className="text-orange-600 group-hover:text-white" /></div>
              </a>
              <a href="mailto:flexfitslebanon@gmail.com" className="text-[10px] font-black flex items-center gap-2 text-gray-500 hover:text-white transition-all uppercase tracking-[0.2em] italic">
                <Mail size={16} className="text-orange-600" /> flexfitslebanon@gmail.com
              </a>
            </div>
          </div>
        </div>
        <div className="pt-8 border-t border-white/5 text-[9px] font-black text-gray-800 uppercase tracking-[0.4em] flex flex-col md:flex-row justify-between items-center gap-4">
            <p>© {currentYear} FLEX FITS | PURELY ORIGINAL GEAR</p>
           <div className="flex gap-6">
             <span className="flex items-center gap-2"><CheckCircle size={12} className="text-orange-900" /> AUTHENTIC ONLY</span>
             <span className="flex items-center gap-2"><CheckCircle size={12} className="text-orange-900" /> PREMIUM SELECTION</span>
           </div>
        </div>
      </div>
    </footer>
  );

  if (isLoading) {
    return (
      <div className="min-h-screen bg-gray-50 flex items-center justify-center">
        <div className="text-center">
          <div className="w-16 h-16 border-4 border-orange-600 border-t-transparent rounded-full animate-spin mx-auto mb-4"></div>
          <p className="text-gray-600 font-bold uppercase tracking-widest">Loading FLEX FITS...</p>
        </div>
      </div>
    );
  }

  return (
    <div className="min-h-screen bg-gray-50 selection:bg-orange-500 selection:text-white">
      {view !== 'admin' && <AnnouncementBar />}
      <nav className="sticky top-0 z-50 bg-white border-b border-gray-200 shadow-sm">
        <div className="max-w-7xl mx-auto px-4 sm:px-6 lg:px-8">
          <div className="flex justify-between items-center h-16 md:h-[72px]">
            <div className="flex items-center gap-6">
              <div onClick={() => setView('home')} className="cursor-pointer hover:opacity-80 transition-opacity">
                <FlexLogo className="h-7 text-black" />
              </div>
              <div className="hidden md:flex gap-5 font-semibold text-sm uppercase tracking-wide text-gray-600">
                <button onClick={() => setView('home')} className={view === 'home' ? 'text-orange-600' : ''}>Home</button>
                <button onClick={() => { setView('shop'); window.scrollTo(0, 0); }} className={view === 'shop' ? 'text-orange-600' : ''}>Shop</button>
              </div>
            </div>
            <div className="flex items-center gap-4">
              <div className="hidden md:flex items-center bg-gray-100 rounded-full px-3 py-1.5">
                <Search size={14} className="text-gray-400" />
                <input
                  type="text" placeholder="Search curated goods..." className="bg-transparent border-none focus:ring-0 text-sm ml-2 w-32 md:w-44"
                  value={searchQuery} onChange={(e) => { setSearchQuery(e.target.value); setView('shop'); }}
                />
              </div>
              <button onClick={() => setView('cart')} aria-label="Open bag" className="relative p-2 text-gray-600 hover:text-orange-600 transition-colors">
                <ShoppingBag size={22} />
                {cart.length > 0 && (
                  <span className="absolute top-0 right-0 bg-orange-600 text-white text-[10px] px-1.5 rounded-full font-bold">
                    {cart.reduce((a, b) => a + b.quantity, 0)}
                  </span>
                )}
              </button>
            </div>
          </div>
          <div className="md:hidden pb-3">
            <div className="flex items-center bg-gray-100 rounded-full px-3 py-2">
              <Search size={14} className="text-gray-400" />
              <input
                type="text"
                placeholder="Search curated goods..."
                className="bg-transparent border-none focus:ring-0 text-sm ml-2 w-full"
                value={searchQuery}
                onChange={(e) => { setSearchQuery(e.target.value); setView('shop'); }}
              />
            </div>
          </div>
        </div>
      </nav>
      <main className="min-h-[80vh]">
        {view === 'home' && (
          <div className="space-y-0">
            <a
              href="https://t.me/flexfitsbot"
              target="_blank"
              rel="noreferrer"
              aria-label="Chat with Flex Fits support on Telegram"
              title="Chat with us on Telegram"
              className="fixed bottom-6 right-6 z-40 flex items-center justify-center w-14 h-14 rounded-full bg-orange-600 text-white shadow-2xl shadow-orange-600/40 hover:bg-orange-700 hover:scale-110 transition-all"
            >
              <MessageCircle size={26} />
            </a>

            <HeroBannerSlider setView={setView} />

            <HomepageSections
              products={products}
              setView={setView}
              openProduct={openProductPage}
              setSelectedBrands={setSelectedBrands}
              setShowOnSaleOnly={setShowOnSaleOnly}
            />

            <div className="bg-white py-20 border-y-4 border-gray-50">
              <div className="max-w-7xl mx-auto px-4 md:px-8 grid grid-cols-1 md:grid-cols-2 gap-8 md:gap-16">
                 <div className="group space-y-6">
                   <div className="w-16 h-16 bg-orange-50 rounded-2xl flex items-center justify-center text-orange-600 group-hover:scale-110 group-hover:rotate-6 transition-all shadow-xl shadow-orange-100/50">
                     <CheckCircle size={32} />
                   </div>
                   <h3 className="text-2xl font-black uppercase italic tracking-tighter text-black">Zero Compromise Authenticity</h3>
                   <p className="text-gray-400 text-sm font-medium leading-relaxed max-w-lg italic">Every asset in our catalog is verified through a rigorous dual-phase authentication process. We deal exclusively in originals. No fakes. No copies. No exceptions.</p>
                 </div>
                 <div className="group space-y-6">
                   <div className="w-16 h-16 bg-blue-50 rounded-2xl flex items-center justify-center text-blue-600 group-hover:scale-110 group-hover:-rotate-6 transition-all shadow-xl shadow-blue-100/50">
                     <Truck size={32} />
                   </div>
                   <h3 className="text-2xl font-black uppercase italic tracking-tighter text-black">Professional Distribution</h3>
                   <p className="text-gray-400 text-sm font-medium leading-relaxed max-w-lg italic">Our logistics network is optimized for the Lebanese terrain. We ensure your premium gear arrives in perfect condition, from the heart of Beirut to the furthest village.</p>
                 </div>
              </div>
            </div>
          </div>
        )}
        
        {view === 'product' && (
          <div className="max-w-7xl mx-auto px-4 py-10 md:py-14 animate-fade-in-up">
            {isLoading && !activeProduct ? (
              <div className="bg-white rounded-3xl border border-gray-100 p-10 text-center shadow-xl">
                <h2 className="text-xl font-black uppercase italic tracking-tighter text-black mb-2">Loading product</h2>
                <p className="text-gray-500 font-semibold text-sm">Fetching the catalog and product details.</p>
              </div>
            ) : !activeProduct ? (
              <div className="bg-white rounded-3xl border border-dashed border-gray-200 p-10 text-center">
                <h2 className="text-xl font-black uppercase italic tracking-tighter text-black mb-2">Product not found</h2>
                <p className="text-gray-500 font-semibold text-sm mb-6">The product may have been removed or the link is invalid.</p>
                <button onClick={() => { setView('shop'); window.scrollTo(0, 0); }} className="bg-black text-white px-6 py-3 rounded-full font-black uppercase tracking-widest text-xs">Back to Shop</button>
              </div>
            ) : (
              <div className="grid grid-cols-1 lg:grid-cols-[1.1fr_0.9fr] gap-8 lg:gap-12">
                <div className="space-y-4">
                  <div className="rounded-[2rem] border border-gray-100 bg-white overflow-hidden shadow-xl">
                    <div className="relative aspect-[4/5] bg-white flex items-center justify-center overflow-hidden">
                      <div
                        className="flex h-full w-full transition-transform duration-700 ease-out will-change-transform"
                        style={{ transform: `translateX(-${Math.min(productDetailSelectedImageIndex, Math.max(0, activeProductImages.length - 1)) * 100}%)` }}
                      >
                        {(activeProductImages.length > 0 ? activeProductImages : [activeProduct.image]).map((image, index) => (
                          <div key={`${activeProduct.Product_ID}-${image}-${index}`} className="h-full w-full flex-shrink-0">
                            <SafeImage src={image} alt={activeProduct.name} className="w-full h-full object-contain p-4" eager={index === 0} />
                          </div>
                        ))}
                      </div>
                      <button
                        type="button"
                        onClick={() => openImageViewer(activeProduct, productDetailSelectedImageIndex)}
                        className="absolute inset-0 z-10 cursor-zoom-in"
                        aria-label="Open product image viewer"
                      />
                    </div>
                  </div>
                  <div className="grid grid-cols-4 sm:grid-cols-6 gap-2">
                    {activeProductImages.map((image, index) => (
                      <button
                        key={image + index}
                        type="button"
                        onClick={() => {
                          productGalleryManualPauseUntilRef.current = Date.now() + 8000;
                          setProductDetailSelectedImageIndex(index);
                        }}
                        className={`rounded-xl border overflow-hidden bg-white aspect-square ${productDetailSelectedImageIndex === index ? 'border-orange-500 ring-2 ring-orange-100' : 'border-gray-100'}`}
                      >
                        <SafeImage src={image} alt={`${activeProduct.name} thumbnail ${index + 1}`} className="w-full h-full object-contain p-1.5" />
                      </button>
                    ))}
                  </div>
                </div>

                <div className="space-y-6 bg-white rounded-[2rem] border border-gray-100 p-6 md:p-8 shadow-xl h-fit sticky top-24">
                  <div>
                    <p className="text-[10px] font-black uppercase tracking-[0.4em] text-orange-600 mb-2">{activeProduct.category}</p>
                    <h1 className="text-3xl md:text-4xl font-black uppercase italic tracking-tighter text-black leading-none mb-3">{activeProduct.productName || activeProduct.name}</h1>
                    <p className="text-sm font-semibold text-gray-500 leading-relaxed">{activeProduct.description}</p>
                  </div>

                  <div className="flex items-end gap-3">
                    {activeProduct.onSale && activeProduct.originalPrice && activeProduct.originalPrice > activeProduct.price ? (
                      <>
                        <span className="text-4xl font-black italic tracking-tighter text-black">${activeProduct.price.toFixed(2)}</span>
                        <span className="text-lg font-bold text-gray-400 line-through">${activeProduct.originalPrice.toFixed(2)}</span>
                        <span className="px-3 py-1 rounded-full bg-orange-100 text-orange-700 text-[10px] font-black uppercase tracking-[0.2em]">-{Math.round((1 - (activeProduct.price / activeProduct.originalPrice)) * 100)}%</span>
                      </>
                    ) : (
                      <span className="text-4xl font-black italic tracking-tighter text-black">${activeProduct.price.toFixed(2)}</span>
                    )}
                  </div>

                  <div>
                    <div className="flex items-center justify-between mb-3">
                      <h3 className="text-[10px] font-black uppercase tracking-[0.35em] text-gray-400">Available Sizes</h3>
                      <span className="text-[10px] font-black uppercase tracking-[0.25em] text-gray-400">{getTotalSizeStock(activeProduct)} in stock</span>
                    </div>
                    <div className="grid grid-cols-3 sm:grid-cols-4 gap-2">
                      {activeProduct.sizes.map((size) => {
                        const sizeStock = getSizeStock(activeProduct, size);
                        const committedSizeAvailable = getCommittedAvailableForSize(activeProduct, size);
                        const isReservedForSize = sizeStock <= 0 && committedSizeAvailable > 0;
                        const isSelected = productDetailSelectedSize === size;
                        const isUnavailable = sizeStock <= 0 || !isProductPurchasableForCustomer(activeProduct);
                        return (
                          <button key={size} type="button" onClick={() => { if (!isUnavailable) { setProductDetailSelectedSize(size); setProductDetailQuantity(1); } }} disabled={isUnavailable} className={`rounded-xl border px-3 py-3 text-[11px] font-black uppercase tracking-widest transition-all ${isSelected ? 'bg-black text-white border-black' : isUnavailable ? 'bg-gray-50 text-gray-300 border-gray-100 cursor-not-allowed' : 'bg-white text-gray-700 border-gray-200 hover:border-orange-500'}`}>
                            <span className="block">{size}</span>
                            <span className="mt-1 block text-[9px] font-bold normal-case tracking-normal">{sizeStock > 0 ? `${sizeStock} left` : isReservedForSize ? 'Reserved' : 'Out of stock'}</span>
                          </button>
                        );
                      })}
                    </div>
                    {(() => {
                      const availabilityState = getProductAvailabilityState(activeProduct);
                      if (availabilityState === 'reserved') {
                        return (
                          <p className="mt-3 text-[10px] font-black uppercase tracking-[0.18em] text-amber-600">
                            This product is currently reserved by another customer.
                          </p>
                        );
                      }
                      if (!isProductPurchasableForCustomer(activeProduct)) {
                        return (
                          <p className="mt-3 text-[10px] font-black uppercase tracking-[0.18em] text-red-500">
                            This product is currently unavailable.
                          </p>
                        );
                      }
                      return null;
                    })()}
                  </div>

                  {productDetailSelectedSize && (
                    <div className="p-4 rounded-2xl bg-gray-50 border border-gray-100">
                      <div className="flex items-center justify-between mb-3">
                        <p className="text-[10px] font-black uppercase tracking-[0.3em] text-gray-400">Quantity</p>
                        <p className="text-[10px] font-black uppercase tracking-[0.2em] text-gray-500">Max {Math.max(1, getSizeStock(activeProduct, productDetailSelectedSize))}</p>
                      </div>
                      <div className="flex items-center gap-2">
                        <button
                          type="button"
                          onClick={() => setProductDetailQuantity((prev) => Math.max(1, prev - 1))}
                          className="w-9 h-9 rounded-lg border border-gray-200 bg-white font-black text-gray-700"
                        >
                          -
                        </button>
                        <input
                          type="number"
                          min={1}
                          max={Math.max(1, getSizeStock(activeProduct, productDetailSelectedSize))}
                          value={productDetailQuantity}
                          onChange={(event) => {
                            const max = Math.max(1, getSizeStock(activeProduct, productDetailSelectedSize));
                            const next = Math.floor(Number(event.target.value || 1));
                            setProductDetailQuantity(Math.max(1, Math.min(max, next)));
                          }}
                          className="w-20 h-9 text-center rounded-lg border border-gray-200 bg-white text-sm font-black"
                        />
                        <button
                          type="button"
                          onClick={() => setProductDetailQuantity((prev) => Math.min(Math.max(1, getSizeStock(activeProduct, productDetailSelectedSize)), prev + 1))}
                          className="w-9 h-9 rounded-lg border border-gray-200 bg-white font-black text-gray-700"
                        >
                          +
                        </button>
                      </div>
                    </div>
                  )}

                  <div className="flex flex-wrap gap-2">
                    {getProductColorTokens(activeProduct).map((c) => (
                      <span key={c} className="text-[10px] font-black uppercase px-3 py-1 rounded-full bg-gray-100 text-gray-600 border border-gray-200">{c}</span>
                    ))}
                  </div>

                  <div className="grid grid-cols-1 sm:grid-cols-2 gap-3 text-sm">
                    <div className="p-4 rounded-2xl bg-gray-50 border border-gray-100">
                      <p className="text-[10px] font-black uppercase tracking-[0.3em] text-gray-400 mb-1">Gender</p>
                      <p className="font-bold text-gray-900">{normalizeGender(activeProduct.gender)}</p>
                    </div>
                    <div className="p-4 rounded-2xl bg-gray-50 border border-gray-100">
                      <p className="text-[10px] font-black uppercase tracking-[0.3em] text-gray-400 mb-1">Type</p>
                      <p className="font-bold text-gray-900">{activeProduct.type}</p>
                    </div>
                  </div>

                  <div className="flex gap-3">
                    <button type="button" onClick={() => { setView('shop'); setSelectedProductId(null); window.scrollTo(0, 0); }} className="px-5 py-3 rounded-full border border-gray-200 font-black uppercase tracking-widest text-[10px] text-gray-600 hover:border-black hover:text-black transition-colors">Back</button>
                    <button type="button" disabled={!productDetailSelectedSize || getSizeStock(activeProduct, productDetailSelectedSize) <= 0 || !isProductPurchasableForCustomer(activeProduct)} onClick={async () => {
                      if (!productDetailSelectedSize) return;
                      const added = await addToCart(activeProduct, productDetailSelectedSize, productDetailQuantity);
                      if (added) setView('cart');
                    }} className="flex-1 bg-orange-600 text-white font-black uppercase tracking-widest text-[10px] rounded-full px-5 py-3 disabled:opacity-40 disabled:cursor-not-allowed hover:bg-orange-700 transition-colors">
                      Add {productDetailSelectedSize ? productDetailQuantity : ''} to Cart
                    </button>
                  </div>
                </div>
              </div>
            )}
          </div>
        )}

        {view === 'shop' && (
          <div className="max-w-[1680px] w-full mx-auto px-2 sm:px-4 lg:px-6 xl:px-8 py-8 md:py-12 overflow-x-hidden">
            <div className="md:hidden mb-6">
              <button
                onClick={() => {
                  setIsMobileFilterOpen(true);
                  setMobileFilterPanelOffsetY(0);
                }}
                className="w-full bg-white border-2 border-gray-100 rounded-2xl px-4 py-3 flex items-center justify-between shadow-sm"
              >
                <span className="flex items-center gap-2 text-[11px] font-black uppercase tracking-wider text-gray-700 italic">
                  <Filter size={16} className="text-orange-600" />
                  Classification
                </span>
                <span className="text-[10px] font-black uppercase text-orange-600 tracking-widest">
                  {selectedGenders.length + selectedSizeFilters.length + selectedColorFilters.length + (hideSoldOutItems ? 1 : 0) + (showOnSaleOnly ? 1 : 0) + (filterCategory !== 'All' ? 1 : 0) + (maxPrice !== 150 ? 1 : 0)} Active
                </span>
              </button>
            </div>

            <div className="flex flex-col md:flex-row gap-6 md:gap-6 lg:gap-8">
              <div className="hidden md:block md:w-52 lg:w-56 xl:w-[230px] flex-shrink-0 xl:-ml-1">
                <div className="bg-white p-4 rounded-2xl border-2 border-gray-50 shadow-xl sticky top-20">
                  {renderFilterControls()}
                </div>
              </div>

              <div className="flex-1 space-y-8 min-w-0">
              {products.some((product) => /t-?shirt|hoodie/i.test(product.type)) && filteredProducts.length === 0 ? (
                <div className="min-h-[60vh] flex items-center justify-center">
                  <div className="text-center px-8 py-24 bg-white rounded-3xl border-2 border-dashed border-orange-600 shadow-xl">
                    <div className="text-6xl mb-6">👕🧥</div>
                    <h2 className="text-4xl md:text-5xl font-black uppercase italic tracking-tighter text-black mb-4">Coming Soon</h2>
                    <p className="text-gray-500 font-bold uppercase tracking-[0.2em] text-sm mb-8 italic max-w-md mx-auto">Premium T-shirts and Hoodies are being carefully curated and authenticated. Stay tuned for the launch of our Collection.</p>
                    <button onClick={() => {setFilterCategory('All'); window.scrollTo(0,0);}} className="bg-orange-600 text-white px-8 py-3 rounded-full font-black hover:bg-orange-700 transition-all uppercase tracking-widest italic shadow-2xl shadow-orange-600/30">Explore Available Gear</button>
                  </div>
                </div>
              ) : (
                <>
              <div className="flex flex-col md:flex-row md:items-end justify-between gap-6 mb-6">
                 <div>
                   <div className="flex items-center gap-2 mb-2">
                     <span className="w-8 h-1 bg-orange-600 rounded-full"></span>
                     <span className="text-[10px] font-black uppercase tracking-[0.4em] text-orange-600 italic">Verified Inventory</span>
                   </div>
                   <h2 className="text-xl md:text-2xl font-black uppercase tracking-tighter italic text-black leading-none">{filterCategory}</h2>
                 </div>
                 <div className="bg-white border-2 border-gray-50 px-4 py-2 rounded-2xl shadow-sm">
                   <p className="text-gray-300 font-black uppercase text-[10px] tracking-[0.3em]">{filteredProducts.length} Assets Found</p>
                 </div>
              </div>

              <div className="grid grid-cols-2 sm:grid-cols-3 lg:grid-cols-4 gap-3 sm:gap-4 lg:gap-4 xl:gap-5">
                {filteredProducts.map((p) => (
                  <ProductCard
                    key={p.Product_ID}
                    product={p}
                    openProduct={openProductPage}
                    getSizeStockValue={getSizeStock}
                    getTotalStock={getTotalSizeStock}
                  />
                ))}
                {filteredProducts.length === 0 && (
                  <div className="col-span-full py-24 text-center bg-white rounded-3xl border-2 border-dashed border-gray-50">
                    <Search className="mx-auto text-gray-100 mb-6" size={60} />
                    <p className="text-gray-300 font-black uppercase tracking-[0.3em] text-sm italic">Catalog mismatch — Modify filters</p>
                  </div>
                )}
              </div>
                </>
              )}
              </div>
            </div>

            {isMobileFilterOpen && (
              <div className="fixed inset-0 z-[70] md:hidden">
                <button
                  aria-label="Close filters"
                  onClick={() => setIsMobileFilterOpen(false)}
                  className="absolute inset-0 bg-black/40 backdrop-blur-[1px]"
                />
                <div
                  onTouchStart={handleMobileFilterTouchStart}
                  onTouchMove={handleMobileFilterTouchMove}
                  onTouchEnd={handleMobileFilterTouchEnd}
                  className="absolute inset-x-0 bottom-0 bg-white rounded-t-3xl border-t border-gray-100 shadow-2xl max-h-[85vh] overflow-y-auto transition-transform duration-200 ease-out"
                  style={{ transform: `translateY(${mobileFilterPanelOffsetY}px)` }}
                >
                  <div className="sticky top-0 bg-white border-b border-gray-100 px-4 py-3 flex items-center justify-between">
                    <div className="absolute top-1 left-1/2 -translate-x-1/2 w-10 h-1 rounded-full bg-gray-200" aria-hidden="true" />
                    <h3 className="font-black text-xs uppercase tracking-[0.4em] text-gray-500 italic">Classification</h3>
                    <span className="text-[9px] font-black uppercase tracking-widest text-gray-400">Swipe down to close</span>
                  </div>
                  <div className="p-4">
                    {renderFilterControls()}
                  </div>
                </div>
              </div>
            )}

            {imageViewerProduct && (
              <div className="fixed inset-0 z-[90] bg-black/90 backdrop-blur-sm">
                <button
                  aria-label="Close image viewer"
                  onClick={closeImageViewer}
                  className="absolute inset-0"
                />
                <button
                  aria-label="Close"
                  onClick={closeImageViewer}
                  className="absolute top-3 right-3 z-[92] w-10 h-10 rounded-full bg-white/10 border border-white/20 text-white flex items-center justify-center hover:bg-white/20 transition-colors"
                >
                  <X size={18} />
                </button>

                <div className="absolute top-3 left-3 z-[92] bg-white/10 border border-white/20 text-white rounded-full px-3 py-1.5 text-[10px] font-black uppercase tracking-[0.14em]">
                  Pinch or wheel to zoom{imageViewerImages.length > 1 ? ' • swipe to switch' : ''}
                </div>

                {imageViewerImages.length > 1 && (
                  <>
                    <button
                      type="button"
                      onClick={() => stepImageViewer(-1)}
                      aria-label="Previous image"
                      className="absolute left-3 sm:left-5 top-1/2 -translate-y-1/2 z-[92] w-10 h-10 rounded-full bg-white/10 border border-white/20 text-white flex items-center justify-center hover:bg-white/20 transition-colors"
                    >
                      <ChevronRight size={18} className="rotate-180" />
                    </button>
                    <button
                      type="button"
                      onClick={() => stepImageViewer(1)}
                      aria-label="Next image"
                      className="absolute right-3 sm:right-5 top-1/2 -translate-y-1/2 z-[92] w-10 h-10 rounded-full bg-white/10 border border-white/20 text-white flex items-center justify-center hover:bg-white/20 transition-colors"
                    >
                      <ChevronRight size={18} />
                    </button>
                    <div className="absolute bottom-3 left-1/2 -translate-x-1/2 z-[92] bg-white/10 border border-white/20 text-white rounded-full px-3 py-1 text-[10px] font-black uppercase tracking-[0.12em]">
                      {imageViewerImageIndex + 1} / {imageViewerImages.length}
                    </div>
                  </>
                )}

                <div
                  onClick={(event) => event.stopPropagation()}
                  onWheel={handleImageViewerWheel}
                  onTouchStart={handleImageViewerTouchStart}
                  onTouchMove={handleImageViewerTouchMove}
                  onTouchEnd={handleImageViewerTouchEnd}
                  className="absolute inset-0 z-[91] flex items-center justify-center p-4 sm:p-8 touch-none"
                >
                  <img
                    src={imageViewerActiveSrc}
                    alt={imageViewerProduct.productName || imageViewerProduct.name}
                    draggable={false}
                    style={{ transform: `translate(${imageViewerTranslate.x}px, ${imageViewerTranslate.y}px) scale(${imageViewerScale})` }}
                    className="max-w-full max-h-full object-contain transition-transform duration-100 select-none"
                  />
                </div>
              </div>
            )}
          </div>
        )}

        {view === 'admin' && <AdminPanel
          products={products}
          orders={orders}
          isAdmin={isAdmin}
          isLoading={isLoading}
          setIsAdmin={setIsAdmin}
          setProducts={setProducts}
          setOrders={setOrders}
          syncProductToDatabase={syncProductToDatabase}
        />}
        {view === 'cart' && <CartView
          cart={cart}
          setView={setView}
          cartNotice={cartNotice}
          removeFromCart={removeFromCart}
          getRemainingMs={getRemainingMs}
          formatRemaining={formatRemaining}
        />}
        {view === 'checkout' && <CheckoutView
          cart={cart}
          setCart={setCart}
          setCartNotice={setCartNotice}
          setOrders={setOrders}
          setProducts={setProducts}
          setView={setView}
          syncOrderToDatabase={syncOrderToDatabase}
        />}
      </main>
      <Footer />
      
      <style>{`
        @keyframes slow-zoom {
          from { transform: scale(1.0); }
          to { transform: scale(1.15); }
        }
        .animate-slow-zoom {
          animation: slow-zoom 30s infinite alternate ease-in-out;
        }
        @keyframes fade-in-up {
          from { opacity: 0; transform: translateY(40px); }
          to { opacity: 1; transform: translateY(0); }
        }
        .animate-fade-in-up {
          animation: fade-in-up 1s cubic-bezier(0.16, 1, 0.3, 1) forwards;
        }
        .delay-100 { animation-delay: 0.1s; }
        .delay-200 { animation-delay: 0.2s; }
        
        .shadow-3xl {
          box-shadow: 0 40px 80px -20px rgba(0, 0, 0, 0.2);
        }

        input[type='range']::-webkit-slider-thumb {
          -webkit-appearance: none;
          height: 24px;
          width: 24px;
          border-radius: 50%;
          background: #f97316;
          cursor: pointer;
          border: 4px solid white;
          box-shadow: 0 4px 10px rgba(0,0,0,0.1);
        }
      `}</style>
    </div>
  );
};


interface AdminPanelProps {
  products: Product[];
  orders: Order[];
  isAdmin: boolean;
  isLoading: boolean;
  setIsAdmin: React.Dispatch<React.SetStateAction<boolean>>;
  setProducts: React.Dispatch<React.SetStateAction<Product[]>>;
  setOrders: React.Dispatch<React.SetStateAction<Order[]>>;
  syncProductToDatabase: (product: Product) => Promise<void>;
}

interface CheckoutViewProps {
  cart: CartItem[];
  setCart: React.Dispatch<React.SetStateAction<CartItem[]>>;
  setCartNotice: React.Dispatch<React.SetStateAction<string>>;
  setOrders: React.Dispatch<React.SetStateAction<Order[]>>;
  setProducts: React.Dispatch<React.SetStateAction<Product[]>>;
  setView: React.Dispatch<React.SetStateAction<View>>;
  syncOrderToDatabase: (order: Order) => Promise<void>;
}

interface CartViewProps {
  cart: CartItem[];
  setView: React.Dispatch<React.SetStateAction<View>>;
  cartNotice: string;
  removeFromCart: (productId: string, size: string) => Promise<void>;
  getRemainingMs: (item: CartItem, nowMs: number) => number;
  formatRemaining: (ms: number) => string;
}

function AdminPanel({ products, orders, isAdmin, isLoading, setIsAdmin, setProducts, setOrders, syncProductToDatabase }: AdminPanelProps) {
  type InventorySection = 'All' | Category | 'ComingSoon';
  type AdminTab = 'orders' | 'add' | 'inventory' | 'financials' | 'theme' | 'tags';
  type BulkRowDraft = {
    price: string;
    originalPrice: string;
    discount: string;
    onSale: boolean;
    status: string;
    stock: string;
  };
  type ImportPreviewRow = {
    rowNumber: number;
    sku: string;
    productName: string;
    category: string;
    price: number;
    stock: number;
    errors: string[];
    payload?: Product;
    duplicateSku?: boolean;
  };
  type ImportSummary = {
    imported: number;
    updated: number;
    skipped: number;
    errors: number;
  };
  const [user, setUser] = useState('');
  const [pass, setPass] = useState('');
  const [isLoggingIn, setIsLoggingIn] = useState(false);
  const [loginError, setLoginError] = useState('');
  const [activeTab, setActiveTab] = useState<AdminTab>('inventory');
  const [editMode, setEditMode] = useState<Product | null>(null);
  const [uploadedImageFiles, setUploadedImageFiles] = useState<File[]>([]);
  const [uploadedImagePreviews, setUploadedImagePreviews] = useState<string[]>([]);
  const [imageValidationErrors, setImageValidationErrors] = useState<string[]>([]);
  const [isUploadingImages, setIsUploadingImages] = useState(false);
  const [formCategory, setFormCategory] = useState<Category>(Category.SHOES);
  const [selectedSizes, setSelectedSizes] = useState<string[]>([]);
  const [brandName, setBrandName] = useState('');
  const [productName, setProductName] = useState('');
  const [formColors, setFormColors] = useState<string>('');
  const [formImagesText, setFormImagesText] = useState<string>('');
  const [formSizeStock, setFormSizeStock] = useState<ProductSizeStock[]>([]);
  const [formStock, setFormStock] = useState<number | ''>('');
  const [formSold, setFormSold] = useState<number | ''>('');
  const [allTags, setAllTags] = useState<Tag[]>([]);
  const [formTagIds, setFormTagIds] = useState<string[]>([]);
  const [inventorySection, setInventorySection] = useState<InventorySection>('All');
  const [inventorySearchQuery, setInventorySearchQuery] = useState('');
  const [inventorySort, setInventorySort] = useState<{ col: 'Product_ID' | 'productName' | 'category'; dir: 'asc' | 'desc' } | null>(null);
  const [financialMetrics, setFinancialMetrics] = useState<FinancialMetric[]>([]);
  const [financialTotals, setFinancialTotals] = useState<FinancialTotals | null>(null);
  const [dispatchingOrderIds, setDispatchingOrderIds] = useState<Set<string>>(new Set());
  const dispatchingOrderIdsRef = useRef<Set<string>>(new Set());
  const [cancelingOrderIds, setCancelingOrderIds] = useState<Set<string>>(new Set());
  const cancelingOrderIdsRef = useRef<Set<string>>(new Set());
  const [inventoryPage, setInventoryPage] = useState(1);
  const inventoryPageSize = 20;
  const fileRef = useRef<HTMLInputElement>(null);
  const importFileRef = useRef<HTMLInputElement>(null);
  const [selectedOrderId, setSelectedOrderId] = useState<string | null>(null);
  const [ordersActionError, setOrdersActionError] = useState<string | null>(null);
  const [importPreviewRows, setImportPreviewRows] = useState<ImportPreviewRow[]>([]);
  const [importErrors, setImportErrors] = useState<string[]>([]);
  const [importSummary, setImportSummary] = useState<ImportSummary | null>(null);
  const [isImporting, setIsImporting] = useState(false);
  const [importFileName, setImportFileName] = useState('');
  const [duplicateBehavior, setDuplicateBehavior] = useState<'update' | 'skip'>('update');
  const [isImportPanelOpen, setIsImportPanelOpen] = useState(false);
  const [selectedProductIds, setSelectedProductIds] = useState<Set<string>>(new Set());
  const [isBulkEditOpen, setIsBulkEditOpen] = useState(false);
  const [isBulkSaving, setIsBulkSaving] = useState(false);
  const [bulkEditDrafts, setBulkEditDrafts] = useState<Record<string, BulkRowDraft>>({});
  const [bulkEditErrors, setBulkEditErrors] = useState<Record<string, string>>({});
  const isShoesCategory = formCategory === Category.SHOES;

  const cycleSort = (col: 'Product_ID' | 'productName' | 'category') => {
    setInventorySort(prev =>
      prev?.col !== col || !prev ? { col, dir: 'asc' }
      : prev.dir === 'asc' ? { col, dir: 'desc' }
      : null
    );
  };

  const splitDisplayName = (fullName: string) => {
    const normalized = (fullName || '').trim();
    if (!normalized) return { brand: '', product: '' };

    if (normalized.includes(' - ')) {
      const [brand, ...rest] = normalized.split(' - ');
      return { brand: brand.trim(), product: rest.join(' - ').trim() };
    }

    const parts = normalized.split(' ');
    if (parts.length <= 1) return { brand: normalized, product: '' };
    return { brand: parts[0], product: parts.slice(1).join(' ') };
  };

  const generateNextProductId = () => {
    const maxExisting = products.reduce((max, p) => {
      const match = /^FF-(\d{3,4})$/i.exec(String(p.Product_ID || ''));
      if (!match) return max;
      return Math.max(max, Number(match[1]));
    }, 100);
    return `FF-${Math.min(9999, maxExisting + 1)}`;
  };

  // adminColorSuggestions removed — colors now use a simple comma-separated text input.

  useEffect(() => {
    if (editMode) {
      setUploadedImageFiles([]);
      setUploadedImagePreviews([]);
      setImageValidationErrors([]);
      setFormCategory(editMode.category);
      setSelectedSizes(editMode.sizes);
      const parsed = splitDisplayName(editMode.name);
      setBrandName(editMode.brandName || parsed.brand);
      setProductName(editMode.productName || parsed.product);
      setFormColors((Array.isArray(editMode.colors) && editMode.colors.length > 0 ? editMode.colors : getProductColorTokens(editMode)).join(', '));
      setFormImagesText((getProductImages(editMode) || []).join(', '));
      setFormSizeStock(buildEditableSizeStock(editMode));
      setFormStock(editMode.initialStock ?? '');
      setFormSold(editMode.sold ?? 0);
      setFormTagIds(editMode.tagIds || []);
      setActiveTab('add');
    } else {
      setUploadedImageFiles([]);
      setUploadedImagePreviews([]);
      setImageValidationErrors([]);
      setSelectedSizes([]);
      setBrandName('');
      setProductName('');
      setFormColors('');
      setFormImagesText('');
      setFormSizeStock([]);
      setFormStock('');
      setFormSold('');
      setFormTagIds([]);
    }
  }, [editMode]);

  useEffect(() => {
    setFormSizeStock((prev) => {
      const next = selectedSizes.map((size) => {
        const existing = prev.find((entry) => entry.size === size);
        return existing || { size, stock: 0, left: 0, sold: 0 };
      });
      return next;
    });
  }, [selectedSizes]);

  useEffect(() => {
    if (!isAdmin) return;

    const timeout = window.setTimeout(() => {
      void (async () => {
        try {
          const metrics = await recalculateFinancialMetrics();
          setFinancialMetrics(metrics);
          const totals = await getFinancialDashboardTotals();
          setFinancialTotals(totals);
        } catch (error) {
          console.error('Error syncing financial metrics:', error);
        }
      })();
    }, 450);

    return () => {
      window.clearTimeout(timeout);
    };
  }, [isAdmin, orders]);

  useEffect(() => {
    return () => {
      for (const preview of uploadedImagePreviews) {
        if (preview.startsWith('blob:')) {
          URL.revokeObjectURL(preview);
        }
      }
    };
  }, [uploadedImagePreviews]);

  const displayFinancialMetrics = useMemo<FinancialMetric[]>(() => {
    if (financialMetrics.length > 0) {
      return financialMetrics;
    }

    return products.map((product) => {
      const totals = getProductStockTotals(product);
      const itemPrice = Number(product.price || 0);
      const itemCost = Number(product.cost || 0);
      const normalizedName = String(product.productName || '').trim()
        || splitDisplayName(product.name).product
        || String(product.name || '').trim()
        || product.Product_ID;

      return {
        productId: product.Product_ID,
        productName: normalizedName,
        itemsSold: totals.sold,
        itemPrice,
        itemCost,
        revenue: totals.sold * itemPrice,
        netProfit: totals.sold * (itemPrice - itemCost),
        calculatedAt: new Date().toISOString(),
      };
    });
  }, [financialMetrics, products]);

  const fallbackRevenue = displayFinancialMetrics.reduce((acc, row) => acc + row.revenue, 0);
  const fallbackProfit = displayFinancialMetrics.reduce((acc, row) => acc + row.netProfit, 0);
  const totalSalesValue = financialTotals?.totalRevenue ?? fallbackRevenue;
  const profit = financialTotals?.totalNetProfit ?? fallbackProfit;

  const inventorySections: InventorySection[] = ['All', ...Object.values(Category), 'ComingSoon'];
  const inventoryProducts = useMemo(() => {
    let list = inventorySection === 'All' ? products
      : inventorySection === 'ComingSoon' ? products.filter(p => /t-?shirt|hoodie/i.test(p.type))
      : products.filter(p => p.category === inventorySection);
    const q = inventorySearchQuery.trim().toLowerCase();
    if (q) {
      list = list.filter((p) => {
        const brand = getProductBrandLabel(p);
        return (
          p.Product_ID.toLowerCase().includes(q) ||
          (p.productName || p.name).toLowerCase().includes(q) ||
          brand.toLowerCase().includes(q) ||
          String(p.type || '').toLowerCase().includes(q) ||
          String(p.category || '').toLowerCase().includes(q)
        );
      });
    }
    if (inventorySort) {
      const { col, dir } = inventorySort;
      list = [...list].sort((a, b) => {
        const va = col === 'Product_ID' ? a.Product_ID : col === 'productName' ? (a.productName || a.name) : a.category;
        const vb = col === 'Product_ID' ? b.Product_ID : col === 'productName' ? (b.productName || b.name) : b.category;
        const cmp = va.localeCompare(vb, undefined, { numeric: true, sensitivity: 'base' });
        return dir === 'asc' ? cmp : -cmp;
      });
    }
    return list;
  }, [products, inventorySection, inventorySearchQuery, inventorySort]);

  useEffect(() => {
    setInventoryPage(1);
  }, [inventorySection, inventorySearchQuery, inventorySort, products.length]);

  const inventoryTotalPages = Math.max(1, Math.ceil(inventoryProducts.length / inventoryPageSize));
  const pagedInventoryProducts = useMemo(() => {
    const start = (inventoryPage - 1) * inventoryPageSize;
    return inventoryProducts.slice(start, start + inventoryPageSize);
  }, [inventoryProducts, inventoryPage, inventoryPageSize]);

  const importableRows = useMemo(
    () => importPreviewRows.filter((row) => row.errors.length === 0 && row.payload),
    [importPreviewRows]
  );

  const isAllCurrentPageSelected = pagedInventoryProducts.length > 0
    && pagedInventoryProducts.every((p) => selectedProductIds.has(p.Product_ID));

  const toggleProductSelected = (productId: string) => {
    setSelectedProductIds((prev) => {
      const next = new Set(prev);
      if (next.has(productId)) next.delete(productId);
      else next.add(productId);
      return next;
    });
  };

  const toggleSelectAllCurrentPage = () => {
    setSelectedProductIds((prev) => {
      const next = new Set(prev);
      if (isAllCurrentPageSelected) {
        for (const p of pagedInventoryProducts) next.delete(p.Product_ID);
      } else {
        for (const p of pagedInventoryProducts) next.add(p.Product_ID);
      }
      return next;
    });
  };

  const clearSelection = () => setSelectedProductIds(new Set());

  const handleBulkDelete = async () => {
    const ids = Array.from(selectedProductIds);
    if (ids.length === 0) return;
    if (!confirm(`Permanently erase ${ids.length} selected asset${ids.length > 1 ? 's' : ''}? This cannot be undone.`)) {
      return;
    }
    setIsBulkSaving(true);
    try {
      for (const id of ids) {
        await deleteProduct(id);
      }
      const refreshedProducts = await getProducts();
      setProducts(refreshedProducts);
      clearSelection();
    } catch (error: any) {
      console.error('Error bulk deleting products:', error);
      alert(error?.message || 'Failed to delete some selected products. Please try again.');
    } finally {
      setIsBulkSaving(false);
    }
  };

  const openBulkEdit = () => {
    if (selectedProductIds.size === 0) return;
    const targets = products.filter((p) => selectedProductIds.has(p.Product_ID));
    const drafts: Record<string, BulkRowDraft> = {};
    for (const product of targets) {
      const totals = getProductStockTotals(product);
      drafts[product.Product_ID] = {
        price: String(product.price ?? ''),
        originalPrice: product.originalPrice != null ? String(product.originalPrice) : '',
        discount: '',
        onSale: Boolean(product.onSale),
        status: product.status || 'Active',
        stock: String(totals.left),
      };
    }
    setBulkEditDrafts(drafts);
    setBulkEditErrors({});
    setIsBulkEditOpen(true);
  };

  const updateBulkDraft = (productId: string, patch: Partial<BulkRowDraft>) => {
    setBulkEditDrafts((prev) => {
      const current = prev[productId];
      if (!current) return prev;
      return { ...prev, [productId]: { ...current, ...patch } };
    });
  };

  const applyBulkDiscount = (product: Product, discountText: string) => {
    setBulkEditDrafts((prev) => {
      const current = prev[product.Product_ID];
      if (!current) return prev;
      const next: BulkRowDraft = { ...current, discount: discountText };
      const discountNum = Number(discountText);
      if (discountText.trim() && Number.isFinite(discountNum) && discountNum >= 0 && discountNum <= 100) {
        const base = Number(current.originalPrice || product.originalPrice || product.price || 0);
        if (base > 0) {
          next.originalPrice = String(base);
          next.price = String(Math.max(0, Math.round(base * (1 - discountNum / 100) * 100) / 100));
        }
      }
      return { ...prev, [product.Product_ID]: next };
    });
  };

  const validateBulkRow = (draft: BulkRowDraft): string | null => {
    const price = Number(draft.price);
    if (!draft.price.trim() || !Number.isFinite(price) || price < 0) {
      return 'Price must be a valid non-negative number.';
    }
    if (draft.originalPrice.trim()) {
      const originalPrice = Number(draft.originalPrice);
      if (!Number.isFinite(originalPrice) || originalPrice < 0) {
        return 'Original price must be a valid non-negative number.';
      }
    }
    if (draft.discount.trim()) {
      const discount = Number(draft.discount);
      if (!Number.isFinite(discount) || discount < 0 || discount > 100) {
        return 'Discount must be a percentage between 0 and 100.';
      }
    }
    const stock = Number(draft.stock);
    if (!draft.stock.trim() || !Number.isInteger(stock) || stock < 0) {
      return 'Stock must be a valid non-negative whole number.';
    }
    return null;
  };

  const handleBulkEditSaveAll = async () => {
    const targets = products.filter((p) => selectedProductIds.has(p.Product_ID));
    if (targets.length === 0) return;

    const nextErrors: Record<string, string> = {};
    for (const product of targets) {
      const draft = bulkEditDrafts[product.Product_ID];
      const error = draft ? validateBulkRow(draft) : 'Missing edits for this product.';
      if (error) nextErrors[product.Product_ID] = error;
    }
    setBulkEditErrors(nextErrors);
    if (Object.keys(nextErrors).length > 0) {
      alert('Fix the highlighted rows before saving.');
      return;
    }

    setIsBulkSaving(true);
    try {
      for (const product of targets) {
        const draft = bulkEditDrafts[product.Product_ID];
        if (!draft) continue;
        const next: Product = { ...product };
        next.price = Number(draft.price);
        next.originalPrice = draft.originalPrice.trim() ? Number(draft.originalPrice) : undefined;
        next.onSale = draft.onSale;
        next.status = draft.status;
        const stockUpdate = buildBulkStockUpdate(product, Math.floor(Number(draft.stock)));
        next.initialStock = stockUpdate.initialStock;
        next.pieces = stockUpdate.pieces;
        if (stockUpdate.sizeStock) next.sizeStock = stockUpdate.sizeStock;
        await syncProductToDatabase(next);
      }
      const refreshedProducts = await getProducts();
      setProducts(refreshedProducts);
      setIsBulkEditOpen(false);
      setBulkEditDrafts({});
      setBulkEditErrors({});
      clearSelection();
    } catch (error: any) {
      console.error('Error applying bulk edit:', error);
      alert(error?.message || 'Failed to apply bulk edit to some products. Please try again.');
    } finally {
      setIsBulkSaving(false);
    }
  };

  const beginOrderDispatch = (orderId: string): boolean => {
    const normalized = String(orderId || '').trim();
    if (!normalized) return false;
    if (dispatchingOrderIdsRef.current.has(normalized)) return false;
    const next = new Set(dispatchingOrderIdsRef.current);
    next.add(normalized);
    dispatchingOrderIdsRef.current = next;
    setDispatchingOrderIds(next);
    return true;
  };

  const endOrderDispatch = (orderId: string): void => {
    const normalized = String(orderId || '').trim();
    if (!normalized || !dispatchingOrderIdsRef.current.has(normalized)) return;
    const next = new Set(dispatchingOrderIdsRef.current);
    next.delete(normalized);
    dispatchingOrderIdsRef.current = next;
    setDispatchingOrderIds(next);
  };

  const beginOrderCancel = (orderId: string): boolean => {
    const normalized = String(orderId || '').trim();
    if (!normalized) return false;
    if (cancelingOrderIdsRef.current.has(normalized)) return false;
    const next = new Set(cancelingOrderIdsRef.current);
    next.add(normalized);
    cancelingOrderIdsRef.current = next;
    setCancelingOrderIds(next);
    return true;
  };

  const endOrderCancel = (orderId: string): void => {
    const normalized = String(orderId || '').trim();
    if (!normalized || !cancelingOrderIdsRef.current.has(normalized)) return;
    const next = new Set(cancelingOrderIdsRef.current);
    next.delete(normalized);
    cancelingOrderIdsRef.current = next;
    setCancelingOrderIds(next);
  };

  const adminNavItems: { key: AdminTab; label: string; icon: React.ComponentType<{ size?: number }> }[] = [
    { key: 'inventory', label: 'Inventory', icon: Layers },
    { key: 'add', label: 'Add/Edit', icon: Plus },
    { key: 'orders', label: 'Orders', icon: Package },
    { key: 'financials', label: 'Financials', icon: BarChart3 },
    { key: 'theme', label: 'Edit Theme', icon: Palette },
    { key: 'tags', label: 'Tags', icon: TagIcon },
  ];

  const selectedOrder = useMemo(
    () => orders.find((order) => order.id === selectedOrderId) || null,
    [orders, selectedOrderId]
  );

  useEffect(() => {
    if (activeTab !== 'orders') {
      setSelectedOrderId(null);
      setOrdersActionError(null);
    }
    if (activeTab !== 'inventory') {
      setIsImportPanelOpen(false);
      setIsBulkEditOpen(false);
    }
  }, [activeTab]);

  useEffect(() => {
    if (activeTab !== 'add' && activeTab !== 'tags') return;
    let isCancelled = false;
    getTags()
      .then((rows) => { if (!isCancelled) setAllTags(rows); })
      .catch((error) => console.error('Error loading tags for product form:', error));
    return () => { isCancelled = true; };
  }, [activeTab]);

  useEffect(() => {
    if (!isImportPanelOpen) {
      setImportSummary(null);
    }
  }, [isImportPanelOpen]);

  if (!isAdmin) {
    const handleLogin = async () => {
      setLoginError('');
      setIsLoggingIn(true);
      try {
        if (supabase) {
          const { error } = await supabase.auth.signInWithPassword({ email: user.trim(), password: pass });
          if (error) {
            setLoginError('Access denied: incorrect email or password.');
            return;
          }
          setIsAdmin(true);
        } else {
          // Dev-only fallback: used solely when Supabase isn't configured (local dev without
          // env vars). The deployed site always has Supabase configured, so this branch never
          // runs in production.
          const isValidLogin = ADMIN_CREDENTIALS.some((credential) => credential.username === user && credential.password === pass);
          if (isValidLogin) setIsAdmin(true);
          else setLoginError('Access denied: incorrect credentials.');
        }
      } finally {
        setIsLoggingIn(false);
      }
    };

    return (
      <div className="min-h-[60vh] flex items-center justify-center p-4">
        <div className="bg-white p-8 rounded-3xl shadow-xl w-full max-w-md border">
          <h2 className="text-xl font-black mb-6 text-center uppercase tracking-widest">Admin Authorization</h2>
          {loginError && (
            <div className="mb-4 bg-red-50 border border-red-200 text-red-700 px-4 py-2.5 rounded-xl text-[11px] font-bold uppercase tracking-wide">
              {loginError}
            </div>
          )}
          <input type="email" placeholder="Admin Email" className="w-full mb-4 p-3 bg-gray-50 rounded-xl border focus:ring-2 focus:ring-orange-500 transition-all outline-none" value={user} onChange={e => setUser(e.target.value)} onKeyDown={(e) => { if (e.key === 'Enter') void handleLogin(); }} />
          <input type="password" placeholder="Password" className="w-full mb-6 p-3 bg-gray-50 rounded-xl border focus:ring-2 focus:ring-orange-500 transition-all outline-none" value={pass} onChange={e => setPass(e.target.value)} onKeyDown={(e) => { if (e.key === 'Enter') void handleLogin(); }} />
          <button disabled={isLoggingIn} onClick={() => void handleLogin()} className="w-full bg-black text-white py-4 rounded-xl font-bold hover:bg-orange-600 transition-all uppercase tracking-widest disabled:opacity-50">
            {isLoggingIn ? 'Logging in...' : 'Login'}
          </button>
        </div>
      </div>
    );
  }

  const toggleSize = (size: string) => {
    setSelectedSizes(prev => prev.includes(size) ? prev.filter(s => s !== size) : [...prev, size]);
  };

  const parseImageUrlTokens = (raw: string): string[] => {
    const source = String(raw || '').trim();
    if (!source) return [];

    const tokens: string[] = [];
    let pendingDataPrefix: string | null = null;

    for (const part of source.split(',')) {
      const trimmed = String(part || '').trim();
      if (!trimmed) continue;

      if (pendingDataPrefix) {
        tokens.push(`${pendingDataPrefix},${trimmed}`);
        pendingDataPrefix = null;
        continue;
      }

      if (/^data:image\/[a-z0-9.+-]+;base64$/i.test(trimmed)) {
        pendingDataPrefix = trimmed;
        continue;
      }

      tokens.push(trimmed);
    }

    if (pendingDataPrefix) {
      tokens.push(pendingDataPrefix);
    }

    return Array.from(new Set(tokens));
  };

  const validateImageUrl = (url: string): Promise<boolean> => {
    return new Promise((resolve) => {
      const candidate = String(url || '').trim();
      if (isValidDataImageUrl(candidate)) {
        resolve(true);
        return;
      }

      // Bounded length keeps this from matching base64 fragments that happen to satisfy this
      // character class otherwise (real local asset paths are always short).
      if (candidate.length <= 200 && /^\/[\w./%+-]+$/i.test(candidate)) {
        resolve(true);
        return;
      }

      if (!/^https?:\/\//i.test(candidate)) {
        resolve(false);
        return;
      }

      const image = new Image();
      const timeout = window.setTimeout(() => {
        image.src = '';
        resolve(false);
      }, 4000);
      image.onload = () => {
        window.clearTimeout(timeout);
        resolve(true);
      };
      image.onerror = () => {
        window.clearTimeout(timeout);
        resolve(false);
      };
      image.src = candidate;
    });
  };

  const normalizeImportKey = (value: string) =>
    String(value || '').trim().toLowerCase().replace(/[^a-z0-9]+/g, '');

  const buildNormalizedRow = (row: Record<string, unknown>) => {
    const normalized: Record<string, unknown> = {};
    for (const [key, value] of Object.entries(row)) {
      normalized[normalizeImportKey(key)] = value;
    }
    return normalized;
  };

  const getImportValue = (row: Record<string, unknown>, keys: string[]) => {
    const normalizedRow = buildNormalizedRow(row);
    for (const key of keys) {
      const normalizedKey = normalizeImportKey(key);
      if (Object.prototype.hasOwnProperty.call(normalizedRow, normalizedKey)) {
        return normalizedRow[normalizedKey];
      }
    }
    return '';
  };

  const parseDelimitedList = (value: unknown): string[] =>
    String(value || '')
      .split(/[,|;]+/)
      .map((token) => token.trim())
      .filter(Boolean);

  const parseNumberField = (value: unknown): number => {
    const parsed = Number(String(value ?? '').trim());
    return Number.isFinite(parsed) ? parsed : NaN;
  };

  const parseSizeStockEntries = (value: unknown): ProductSizeStock[] => {
    const tokens = parseDelimitedList(value);
    const entries: ProductSizeStock[] = [];
    for (const token of tokens) {
      const match = token.match(/^(.+):\s*(\d+)$/);
      if (!match) continue;
      const size = match[1].trim();
      const stock = Math.max(0, Math.floor(Number(match[2])));
      if (!size || !Number.isFinite(stock)) continue;
      entries.push({ size, stock, left: stock, sold: 0 });
    }
    return entries;
  };

  const normalizeCategoryToken = (value: unknown): Category | null => {
    const normalized = String(value || '').trim().toLowerCase();
    const match = Object.values(Category).find((c) => c.toLowerCase() === normalized);
    return match || null;
  };

  const getOrderPaymentStatus = (order: Order): string => {
    const raw = (order as any).paymentStatus || (order as any).payment_status || (order as any).payment;
    return raw ? String(raw) : 'N/A';
  };

  const resetImportState = () => {
    setImportPreviewRows([]);
    setImportErrors([]);
    setImportSummary(null);
    setImportFileName('');
  };

  const handleImportFileChange = async (event: React.ChangeEvent<HTMLInputElement>) => {
    const files = Array.from(event.target.files || []);
    if (files.length === 0) return;
    const file = files[0];

    resetImportState();

    const name = String(file.name || '').toLowerCase();
    const allowedExtensions = ['.xlsx', '.xls', '.csv'];
    if (!allowedExtensions.some((ext) => name.endsWith(ext))) {
      setImportErrors([`Unsupported file type: ${file.name}`]);
      event.target.value = '';
      return;
    }

    try {
      const buffer = await file.arrayBuffer();
      const workbook = XLSX.read(buffer, { type: 'array' });
      const sheetName = workbook.SheetNames[0];
      if (!sheetName) {
        setImportErrors(['No worksheets found in the file.']);
        event.target.value = '';
        return;
      }

      const sheet = workbook.Sheets[sheetName];
      const rawRows = XLSX.utils.sheet_to_json<Record<string, unknown>>(sheet, { defval: '' });
      if (rawRows.length === 0) {
        setImportErrors(['No data rows detected.']);
        event.target.value = '';
        return;
      }

      const existingSkuSet = new Set(products.map((p) => String(p.Product_ID || '').trim().toLowerCase()));
      const seenSkus = new Set<string>();
      const previewRows: ImportPreviewRow[] = rawRows.map((row, index) => {
        const errors: string[] = [];
        const rowNumber = index + 2;

        const sku = String(getImportValue(row, ['sku', 'product_id', 'product id', 'code', 'productid', 'Product_ID'])).trim();
        if (!sku) errors.push('Missing SKU/Product ID.');

        const brandValue = String(getImportValue(row, ['brand', 'brand_name', 'brandname'])).trim();
        const productValue = String(getImportValue(row, ['product', 'product_name', 'productname', 'name'])).trim();
        let resolvedBrand = brandValue;
        let resolvedProduct = productValue;
        if (!resolvedBrand || !resolvedProduct) {
          const combined = brandValue || productValue;
          if (combined) {
            const split = splitDisplayName(combined);
            resolvedBrand = resolvedBrand || split.brand;
            resolvedProduct = resolvedProduct || split.product;
          }
        }
        if (!resolvedProduct) errors.push('Missing product name.');

        const categoryValue = normalizeCategoryToken(getImportValue(row, ['category', 'Category']));
        if (!categoryValue) errors.push('Invalid or missing category.');

        const typeValue = String(getImportValue(row, ['type', 'style'])).trim();
        if (!typeValue) errors.push('Missing type/style.');

        const priceValue = parseNumberField(getImportValue(row, ['price', 'Price']));
        if (!Number.isFinite(priceValue) || priceValue < 0) errors.push('Invalid price.');

        const costValue = parseNumberField(getImportValue(row, ['cost', 'Cost']));
        const resolvedCost = Number.isFinite(costValue) ? costValue : 0;

        const sizeStockValue = parseSizeStockEntries(getImportValue(row, ['size_stock', 'size stock', 'sizestock']));
        const sizesValue = sizeStockValue.length > 0
          ? sizeStockValue.map((entry) => entry.size)
          : parseDelimitedList(getImportValue(row, ['sizes', 'size', 'variants', 'options']));

        if (sizesValue.length === 0) errors.push('Missing sizes/options.');

        const stockValue = parseNumberField(getImportValue(row, ['stock', 'quantity', 'qty', 'items_left', 'itemsleft']));
        const computedStock = sizeStockValue.length > 0
          ? sizeStockValue.reduce((total, entry) => total + entry.stock, 0)
          : stockValue;

        if (!Number.isFinite(computedStock) || computedStock < 0) errors.push('Invalid stock/quantity.');

        const descriptionValue = String(getImportValue(row, ['description', 'details', 'desc'])).trim();
        if (!descriptionValue) errors.push('Missing description.');

        const imageTokens = parseDelimitedList(getImportValue(row, ['images', 'image', 'image_urls', 'imageurls', 'pictures']));
        const normalizedImages = imageTokens.length > 0 ? imageTokens : [BRAND_LOGO_SRC];

        const statusValue = String(getImportValue(row, ['status', 'availability'])).trim() || 'Active';
        const genderValue = normalizeGender(getImportValue(row, ['gender', 'Gender']));
        const colorTokens = parseDelimitedList(getImportValue(row, ['colors', 'color'])).map((c) => c.toLowerCase());

        const originalPriceValue = parseNumberField(getImportValue(row, ['original_price', 'original price', 'compare_at']));
        const onSaleRaw = String(getImportValue(row, ['on_sale', 'onsale', 'sale'])).trim().toLowerCase();
        const onSaleValue = ['true', 'yes', '1'].includes(onSaleRaw);

        const skuKey = sku.toLowerCase();
        if (skuKey && seenSkus.has(skuKey)) {
          errors.push('Duplicate SKU in import file.');
        }
        if (skuKey) seenSkus.add(skuKey);

        const duplicateSku = skuKey ? existingSkuSet.has(skuKey) : false;

        const stockTotal = Number.isFinite(computedStock) ? Math.floor(computedStock) : 0;
        const sizeStockPayload = sizeStockValue.length > 0
          ? sizeStockValue
          : sizesValue.map((size, idx) => {
              const base = Math.floor(stockTotal / sizesValue.length);
              const extra = idx < (stockTotal % sizesValue.length) ? 1 : 0;
              const stock = Math.max(0, base + extra);
              return { size, stock, left: stock, sold: 0 };
            });

        const nameValue = resolvedBrand && resolvedProduct
          ? `${resolvedBrand} - ${resolvedProduct}`
          : resolvedProduct || resolvedBrand || sku;

        const payload = (!errors.length && categoryValue)
          ? {
              Product_ID: sku,
              name: nameValue,
              brandName: resolvedBrand || splitDisplayName(nameValue).brand || resolvedBrand,
              productName: resolvedProduct || splitDisplayName(nameValue).product || resolvedProduct,
              gender: genderValue,
              category: categoryValue,
              type: typeValue,
              price: Number(priceValue),
              cost: resolvedCost,
              initialStock: stockTotal,
              pieces: stockTotal,
              sold: 0,
              sizes: sizesValue,
              sizeStock: sizeStockPayload,
              description: descriptionValue,
              image: normalizedImages[0] || BRAND_LOGO_SRC,
              images: normalizedImages,
              isAuthentic: true,
              status: statusValue,
              colors: colorTokens.length ? colorTokens : undefined,
              color: colorTokens.length ? colorTokens.join(', ') : undefined,
              originalPrice: Number.isFinite(originalPriceValue) ? originalPriceValue : undefined,
              onSale: onSaleValue,
            }
          : undefined;

        return {
          rowNumber,
          sku,
          productName: resolvedProduct || nameValue,
          category: categoryValue || '',
          price: Number.isFinite(priceValue) ? priceValue : 0,
          stock: Number.isFinite(computedStock) ? Math.floor(computedStock) : 0,
          errors,
          payload,
          duplicateSku,
        };
      });

      setImportPreviewRows(previewRows);
      setImportFileName(file.name);
    } catch (error: any) {
      setImportErrors([`Failed to parse file: ${error?.message || 'Unknown error'}`]);
    } finally {
      event.target.value = '';
    }
  };

  const downloadBlob = (blob: Blob, fileName: string) => {
    const url = URL.createObjectURL(blob);
    const link = document.createElement('a');
    link.href = url;
    link.download = fileName;
    document.body.appendChild(link);
    link.click();
    link.remove();
    window.setTimeout(() => URL.revokeObjectURL(url), 1000);
  };

  const buildImportTemplateRows = () => ([
    {
      sku: 'FF-0101',
      brand: 'Flex',
      product_name: 'Court Runner',
      category: 'Shoes',
      type: 'Running',
      gender: 'Unisex',
      price: 120,
      cost: 70,
      stock: 12,
      sizes: '40, 41, 42',
      size_stock: '40:4 | 41:4 | 42:4',
      description: 'Authentic court runner with premium finish.',
      images: 'https://example.com/image-1.jpg, https://example.com/image-2.jpg',
      status: 'Active',
      colors: 'black, white',
      original_price: 140,
      on_sale: true,
    },
  ]);

  const handleDownloadTemplate = (format: 'csv' | 'xlsx') => {
    const rows = buildImportTemplateRows();
    const worksheet = XLSX.utils.json_to_sheet(rows);
    const workbook = XLSX.utils.book_new();
    XLSX.utils.book_append_sheet(workbook, worksheet, 'Template');

    if (format === 'csv') {
      const csv = XLSX.utils.sheet_to_csv(worksheet);
      downloadBlob(new Blob([csv], { type: 'text/csv;charset=utf-8;' }), 'inventory-template.csv');
      return;
    }

    const output = XLSX.write(workbook, { type: 'array', bookType: 'xlsx' });
    downloadBlob(new Blob([output], { type: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet' }), 'inventory-template.xlsx');
  };

  const handleExportInventory = (format: 'csv' | 'xlsx') => {
    const exportProducts = selectedProductIds.size > 0
      ? products.filter((product) => selectedProductIds.has(product.Product_ID))
      : products;
    const rows = exportProducts.map((product) => {
      const totals = getProductStockTotals(product);
      const sizeStock = normalizeSizeStockEntries(product);
      return {
        sku: product.Product_ID,
        brand: product.brandName || splitDisplayName(product.name).brand,
        product_name: product.productName || splitDisplayName(product.name).product,
        category: product.category,
        type: product.type,
        gender: normalizeGender(product.gender),
        price: product.price,
        cost: product.cost,
        stock: totals.stock,
        sizes: (product.sizes || []).join(', '),
        size_stock: sizeStock.length > 0
          ? sizeStock.map((entry) => `${entry.size}:${entry.stock}`).join(' | ')
          : '',
        description: product.description,
        images: (getProductImages(product) || []).join(', '),
        status: product.status || '',
        colors: (getProductColorTokens(product) || []).join(', '),
        original_price: product.originalPrice ?? '',
        on_sale: Boolean(product.onSale),
      };
    });

    const worksheet = XLSX.utils.json_to_sheet(rows);
    const workbook = XLSX.utils.book_new();
    XLSX.utils.book_append_sheet(workbook, worksheet, 'Inventory');

    if (format === 'csv') {
      const csv = XLSX.utils.sheet_to_csv(worksheet);
      downloadBlob(new Blob([csv], { type: 'text/csv;charset=utf-8;' }), 'inventory-export.csv');
      return;
    }

    const output = XLSX.write(workbook, { type: 'array', bookType: 'xlsx' });
    downloadBlob(new Blob([output], { type: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet' }), 'inventory-export.xlsx');
  };

  const handleConfirmImport = async () => {
    if (importPreviewRows.length === 0) return;
    setIsImporting(true);
    setImportSummary(null);

    const existingSkuSet = new Set(products.map((p) => String(p.Product_ID || '').trim().toLowerCase()));
    const summary: ImportSummary = { imported: 0, updated: 0, skipped: 0, errors: 0 };

    for (const row of importPreviewRows) {
      if (row.errors.length > 0 || !row.payload) {
        summary.errors += 1;
        continue;
      }

      const skuKey = String(row.sku || '').trim().toLowerCase();
      if (row.duplicateSku && duplicateBehavior === 'skip') {
        summary.skipped += 1;
        continue;
      }

      try {
        await syncProductToDatabase(row.payload);
        if (skuKey && existingSkuSet.has(skuKey)) {
          summary.updated += 1;
        } else {
          summary.imported += 1;
          if (skuKey) existingSkuSet.add(skuKey);
        }
      } catch (error) {
        console.error('Failed to import product:', row.sku, error);
        summary.errors += 1;
      }
    }

    try {
      const refreshedProducts = await getProducts();
      setProducts(refreshedProducts);
    } catch (refreshError) {
      console.error('Failed to refresh products after import:', refreshError);
    }

    setImportSummary(summary);
    setIsImporting(false);
  };

  const handleFile = (e: React.ChangeEvent<HTMLInputElement>) => {
    const files = Array.from(e.target.files || []);
    if (files.length === 0) return;

    const validFiles: File[] = [];
    const errors: string[] = [];

    for (const file of files) {
      if (Number(file.size || 0) <= 0) {
        errors.push(`${file.name}: empty file.`);
        continue;
      }

      if (file.size > 50 * 1024 * 1024) {
        errors.push(`${file.name}: exceeds 50MB limit.`);
        continue;
      }

      const type = String(file.type || '').toLowerCase();
      if (!['image/jpeg', 'image/png', 'image/webp', 'image/gif'].includes(type)) {
        errors.push(`${file.name}: unsupported format.`);
        continue;
      }

      validFiles.push(file);
    }

    if (errors.length > 0) {
      setImageValidationErrors(errors);
    }

    if (validFiles.length === 0) {
      e.target.value = '';
      return;
    }

    setUploadedImageFiles((prev) => [...prev, ...validFiles]);
    const objectUrls = validFiles.map((file) => URL.createObjectURL(file));
    setUploadedImagePreviews((prev) => [...prev, ...objectUrls]);
    e.target.value = '';
  };

  const saveProduct = async (e: React.FormEvent<HTMLFormElement>) => {
    e.preventDefault();
    const formEl = e.currentTarget;
    if (selectedSizes.length === 0) {
      alert("Select at least one size for this product.");
      return;
    }
    const normalizedBrand = brandName.trim();
    const normalizedProduct = productName.trim();
    if (!normalizedBrand || !normalizedProduct) {
      alert('Please fill both Brand Name and Product Name.');
      return;
    }
    const fd = new FormData(formEl);
    // DEBUG: Log colors state and product ID before building payload
    console.log('[saveProduct] formColors text:', formColors);
    console.log('[saveProduct] editMode?.Product_ID:', editMode?.Product_ID);

    const productId = editMode?.Product_ID || generateNextProductId();
    console.log('[saveProduct] Resolved productId:', productId, '| isEdit:', !!editMode);

    // Parse comma-separated text into a clean string[] for the DB text[] column
    const colorTokens: string[] = Array.from(
      new Set(
        formColors
          .split(',')
          .map((c) => c.trim().toLowerCase())
          .filter(Boolean)
      )
    );
    console.log('[saveProduct] colorTokens to save:', colorTokens);

    const urlImages = parseImageUrlTokens(formImagesText);
    setImageValidationErrors([]);

    const validationResults = await Promise.all(
      urlImages.map(async (candidate) => ({
        candidate,
        isValid: await validateImageUrl(candidate),
      }))
    );
    const invalidUrls = validationResults.filter((entry) => !entry.isValid).map((entry) => entry.candidate);

    if (invalidUrls.length > 0) {
      setImageValidationErrors(invalidUrls.map((url) => `Invalid or unreachable image URL: ${url}`));
      alert('Fix invalid image URLs before saving this product.');
      return;
    }

    let uploadedUrls: string[] = [];
    if (uploadedImageFiles.length > 0) {
      setIsUploadingImages(true);
      try {
        uploadedUrls = await uploadProductImagesToStorage(editMode?.Product_ID || productId, uploadedImageFiles);
      } finally {
        setIsUploadingImages(false);
      }
    }

    const parsedImages = Array.from(new Set([...uploadedUrls, ...urlImages]));
    if (parsedImages.length === 0) {
      alert('Add at least one valid image (upload or URL).');
      return;
    }
    const normalizedSizeStock = selectedSizes.map((size) => {
      const existing = formSizeStock.find((entry) => entry.size === size);
      const stockAmount = Math.max(0, Math.floor(Number(existing?.stock ?? 0)));
      return {
        size,
        stock: stockAmount,
        left: stockAmount,
        sold: 0,
      };
    });

    const explicitSizeStockTotal = normalizedSizeStock.reduce((total, entry) => total + entry.stock, 0);
    const fallbackStock = Number(formStock);
    const resolvedStock = explicitSizeStockTotal > 0
      ? explicitSizeStockTotal
      : Number.isFinite(fallbackStock) && fallbackStock > 0
        ? fallbackStock
        : 0;

    if (resolvedStock <= 0) {
      alert('Add stock for at least one size before saving this product.');
      return;
    }

    const derivedSizeStock = explicitSizeStockTotal > 0
      ? normalizedSizeStock
      : selectedSizes.map((size, index) => {
          const stockAmount = Math.max(0, Math.floor(resolvedStock / selectedSizes.length) + (index < (resolvedStock % selectedSizes.length) ? 1 : 0));
          return {
            size,
            stock: stockAmount,
            left: stockAmount,
            sold: 0,
          };
        });

    const originalPriceValue = Number(fd.get('original_price'));
    const isOnSale = Boolean(fd.get('on_sale'));

    const stock = resolvedStock;
    const itemsSold = Number(formSold === '' ? (editMode?.sold ?? 0) : formSold);
    const piecesLeft = stock - itemsSold;

    if (!Number.isInteger(stock) || stock < 0 || !Number.isInteger(itemsSold) || itemsSold < 0 || itemsSold > stock) {
      alert('Stock and items sold must be valid non-negative integers, and items sold cannot exceed stock.');
      return;
    }
    const newP: Product = {
      Product_ID: productId,
      name: `${normalizedBrand} - ${normalizedProduct}`,
      brandName: normalizedBrand,
      productName: normalizedProduct,
      gender: normalizeGender(fd.get('gender')),
      category: formCategory,
      type: fd.get('type') as string,
      price: Number(fd.get('price')),
      cost: Number(fd.get('cost')),
      initialStock: stock,
      pieces: piecesLeft,
      sold: itemsSold,
      sizes: selectedSizes,
      sizeStock: derivedSizeStock,
      description: fd.get('description') as string,
      image: parsedImages[0] || (fd.get('image') as string) || editMode?.image || '',
      images: parsedImages,
      isAuthentic: true,
      status: (fd.get('status') as string) || 'Active',
      colors: colorTokens,
      color: colorTokens.length ? colorTokens.join(', ') : undefined,
      originalPrice: Number.isFinite(originalPriceValue) && originalPriceValue > 0 ? originalPriceValue : undefined,
      onSale: isOnSale,
      tagIds: formTagIds,
    };
    console.log('[saveProduct] Final payload:', JSON.stringify(newP, null, 2));
    try {
      await syncProductToDatabase(newP);
      const refreshedProducts = await getProducts();
      setProducts(refreshedProducts);
      setEditMode(null);
      setUploadedImageFiles([]);
      setUploadedImagePreviews([]);
      setFormImagesText('');
      setImageValidationErrors([]);
      setFormSizeStock([]);
      setSelectedSizes([]);
      setBrandName('');
      setProductName('');
      setActiveTab('inventory');
      setFormColors('');
      setFormStock('');
      setFormSold('');
      setFormTagIds([]);
      formEl.reset();
    } catch (error: any) {
      console.error('Error saving product:', error);
      const msg = error?.message || error?.error_description || JSON.stringify(error);
      alert(`Failed to save product to database.\n\nError: ${msg}\n\nCheck Supabase dashboard → Table Editor → products → RLS policies.`);
    }
  };

  if (isBulkEditOpen) {
    const bulkTargets = products.filter((p) => selectedProductIds.has(p.Product_ID));
    const closeBulkEdit = () => {
      setIsBulkEditOpen(false);
      setBulkEditDrafts({});
      setBulkEditErrors({});
    };
    return (
      <div className="w-full max-w-[1600px] mx-auto px-4 py-10 min-w-0">
        <div className="bg-white border rounded-2xl overflow-hidden min-w-0">
          <div className="p-4 border-b bg-gray-50 flex flex-wrap items-center justify-between gap-3">
            <div>
              <p className="text-[10px] font-bold uppercase text-gray-500">Bulk Edit</p>
              <h2 className="text-lg font-black uppercase text-gray-900">{bulkTargets.length} Product{bulkTargets.length > 1 ? 's' : ''} Selected</h2>
              <p className="text-[10px] text-gray-500 font-semibold mt-1">Each row is its own product — edit price, discount, stock, and status independently, then save all at once.</p>
            </div>
            <div className="flex gap-2 flex-shrink-0">
              <button
                type="button"
                disabled={isBulkSaving}
                onClick={() => void handleBulkEditSaveAll()}
                className="bg-orange-600 text-white font-black px-6 py-3 rounded-xl uppercase tracking-widest text-xs hover:bg-orange-700 transition-all disabled:opacity-50"
              >
                {isBulkSaving ? 'Saving...' : `Save All (${bulkTargets.length})`}
              </button>
              <button
                type="button"
                disabled={isBulkSaving}
                onClick={closeBulkEdit}
                className="px-5 py-3 rounded-xl border border-gray-200 text-gray-600 font-black uppercase tracking-widest text-xs hover:bg-gray-50 disabled:opacity-50"
              >
                Cancel
              </button>
            </div>
          </div>

          <div className="overflow-x-auto">
            <table className="w-full text-left text-[11px] min-w-[1100px]">
              <thead className="bg-gray-100 uppercase font-black text-gray-500 border-b">
                <tr>
                  <th className="p-3">Product</th>
                  <th className="p-3 whitespace-nowrap">Price ($)</th>
                  <th className="p-3 whitespace-nowrap">Original Price ($)</th>
                  <th className="p-3 whitespace-nowrap">Discount (%)</th>
                  <th className="p-3 whitespace-nowrap">On Sale</th>
                  <th className="p-3 whitespace-nowrap">Stock (Left)</th>
                  <th className="p-3 whitespace-nowrap">Status</th>
                </tr>
              </thead>
              <tbody className="divide-y">
                {bulkTargets.map((product) => {
                  const draft = bulkEditDrafts[product.Product_ID];
                  if (!draft) return null;
                  const rowError = bulkEditErrors[product.Product_ID];
                  return (
                    <tr key={product.Product_ID} className={rowError ? 'bg-red-50/60' : 'hover:bg-gray-50 transition-colors'}>
                      <td className="p-3 max-w-[260px] align-top">
                        <div className="flex items-center gap-2 min-w-0">
                          <div className="w-10 h-10 rounded border overflow-hidden bg-gray-50 flex items-center justify-center flex-shrink-0">
                            <SafeImage src={product.image} className="w-full h-full object-contain p-0.5" alt={product.name} />
                          </div>
                          <div className="min-w-0">
                            <p className="font-semibold text-gray-900 truncate">{product.productName || product.name}</p>
                            <p className="text-[9px] text-gray-400 uppercase font-bold truncate">{product.Product_ID}</p>
                          </div>
                        </div>
                        {rowError && <p className="text-[10px] font-bold text-red-600 mt-1.5">{rowError}</p>}
                      </td>
                      <td className="p-3 align-top">
                        <input
                          type="number"
                          min="0"
                          step="0.01"
                          value={draft.price}
                          onChange={(e) => updateBulkDraft(product.Product_ID, { price: e.target.value })}
                          className="w-24 p-2 bg-gray-50 border rounded-lg text-xs font-bold outline-none focus:ring-2 focus:ring-orange-500"
                        />
                      </td>
                      <td className="p-3 align-top">
                        <input
                          type="number"
                          min="0"
                          step="0.01"
                          value={draft.originalPrice}
                          onChange={(e) => updateBulkDraft(product.Product_ID, { originalPrice: e.target.value })}
                          placeholder="None"
                          className="w-24 p-2 bg-gray-50 border rounded-lg text-xs font-bold outline-none focus:ring-2 focus:ring-orange-500"
                        />
                      </td>
                      <td className="p-3 align-top">
                        <input
                          type="number"
                          min="0"
                          max="100"
                          step="1"
                          value={draft.discount}
                          onChange={(e) => applyBulkDiscount(product, e.target.value)}
                          placeholder="—"
                          className="w-20 p-2 bg-gray-50 border rounded-lg text-xs font-bold outline-none focus:ring-2 focus:ring-orange-500"
                        />
                      </td>
                      <td className="p-3 align-top">
                        <input
                          type="checkbox"
                          checked={draft.onSale}
                          onChange={(e) => updateBulkDraft(product.Product_ID, { onSale: e.target.checked })}
                          className="h-4 w-4 accent-orange-600"
                        />
                      </td>
                      <td className="p-3 align-top">
                        <input
                          type="number"
                          min="0"
                          step="1"
                          value={draft.stock}
                          onChange={(e) => updateBulkDraft(product.Product_ID, { stock: e.target.value })}
                          className="w-20 p-2 bg-gray-50 border rounded-lg text-xs font-bold outline-none focus:ring-2 focus:ring-orange-500"
                        />
                      </td>
                      <td className="p-3 align-top">
                        <select
                          value={draft.status}
                          onChange={(e) => updateBulkDraft(product.Product_ID, { status: e.target.value })}
                          className="p-2 bg-gray-50 border rounded-lg text-xs font-bold outline-none focus:ring-2 focus:ring-orange-500"
                        >
                          <option value="Active">Active</option>
                          <option value="Discontinued">Discontinued</option>
                          <option value="Out of Stock">Out of Stock</option>
                          <option value="Coming Soon">Coming Soon</option>
                        </select>
                      </td>
                    </tr>
                  );
                })}
                {bulkTargets.length === 0 && (
                  <tr>
                    <td colSpan={7} className="p-6 text-center text-gray-500 font-semibold">No products selected.</td>
                  </tr>
                )}
              </tbody>
            </table>
          </div>

          <div className="p-4 border-t bg-gray-50 flex justify-end gap-2">
            <button
              type="button"
              disabled={isBulkSaving}
              onClick={() => void handleBulkEditSaveAll()}
              className="bg-orange-600 text-white font-black px-6 py-3 rounded-xl uppercase tracking-widest text-xs hover:bg-orange-700 transition-all disabled:opacity-50"
            >
              {isBulkSaving ? 'Saving...' : `Save All (${bulkTargets.length})`}
            </button>
            <button
              type="button"
              disabled={isBulkSaving}
              onClick={closeBulkEdit}
              className="px-5 py-3 rounded-xl border border-gray-200 text-gray-600 font-black uppercase tracking-widest text-xs hover:bg-gray-50 disabled:opacity-50"
            >
              Cancel
            </button>
          </div>
        </div>
      </div>
    );
  }

  return (
    <div className="w-full max-w-[1600px] mx-auto px-4 py-10">
      <div className="grid grid-cols-1 lg:grid-cols-[240px_1fr] gap-6 min-w-0">
        <aside className="bg-white border rounded-2xl p-4 h-fit lg:sticky lg:top-6 lg:max-h-[calc(100vh-3rem)] lg:overflow-y-auto min-w-0">
          <div className="mb-6">
            <p className="text-[10px] font-bold uppercase text-gray-500 mb-1">Admin Dashboard</p>
            <h2 className="text-lg font-black uppercase text-gray-900">Inventory Control</h2>
          </div>
          <div className="space-y-2">
            {adminNavItems.map((item) => {
              const Icon = item.icon;
              const isActive = activeTab === item.key;
              return (
                <button
                  key={item.key}
                  onClick={() => setActiveTab(item.key)}
                  className={`w-full px-3 py-2 rounded-xl font-bold uppercase text-[11px] transition-colors flex items-center gap-2 border ${isActive ? 'bg-gray-900 text-white border-gray-900' : 'bg-white text-gray-700 border-gray-200 hover:bg-gray-50'}`}
                >
                  <Icon size={14} />
                  <span>{item.label}</span>
                </button>
              );
            })}
          </div>
          <div className="mt-6 pt-4 border-t border-gray-100">
            <button
              onClick={() => { if (supabase) void supabase.auth.signOut(); setIsAdmin(false); }}
              className="w-full bg-white hover:bg-red-50 text-gray-700 hover:text-red-600 px-3 py-2 rounded-xl transition-colors font-bold uppercase text-[11px] flex items-center gap-2 border border-gray-200"
            >
              <LogOut size={14} />
              Log out
            </button>
          </div>
        </aside>

        <div className="space-y-6 min-w-0">
          <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-3 gap-4">
            <div className="bg-white p-4 rounded-xl border min-w-0 overflow-hidden">
              <div className="flex justify-between items-center mb-1 gap-2">
                <BarChart3 className="text-gray-500 flex-shrink-0" size={18} />
                <span className="text-[10px] font-bold uppercase text-gray-500 truncate">Total Revenue</span>
              </div>
              <p className="text-lg md:text-xl font-black truncate">${totalSalesValue.toLocaleString()}</p>
            </div>
            <div className="bg-white p-4 rounded-xl border min-w-0 overflow-hidden">
              <div className="flex justify-between items-center mb-1 gap-2">
                <Package className="text-gray-500 flex-shrink-0" size={18} />
                <span className="text-[10px] font-bold uppercase text-gray-500 truncate">Orders Fulfilled</span>
              </div>
              <p className="text-lg md:text-xl font-black truncate">{orders.length}</p>
            </div>
            <div className="bg-white p-4 rounded-xl border min-w-0 overflow-hidden">
              <div className="flex justify-between items-center mb-1 gap-2">
                <Star className="text-gray-500 flex-shrink-0" size={18} />
                <span className="text-[10px] font-bold uppercase text-gray-500 truncate">Net Profit</span>
              </div>
              <p className="text-lg md:text-xl font-black text-gray-900 truncate">${profit.toLocaleString()}</p>
            </div>
          </div>

      {activeTab === 'financials' && (
        <div className="bg-white border rounded-xl overflow-hidden mb-8">
          <div className="p-4 border-b bg-gray-50 flex items-center justify-between gap-3">
            <div>
              <p className="text-[10px] font-bold uppercase text-gray-500">Financial Breakdown (Database)</p>
              <h3 className="text-sm md:text-base font-black uppercase text-gray-900">Revenue & Net Profit Per Product</h3>
            </div>
            <span className="text-[10px] bg-gray-900 text-white px-3 py-1 rounded-full font-bold uppercase">{displayFinancialMetrics.length} Items</span>
          </div>
          <div className="overflow-x-auto">
            <table className="w-full text-left text-[11px] min-w-[900px]">
              <thead className="bg-gray-100 uppercase font-black text-gray-500 border-b">
                <tr>
                  <th className="p-3">Product_ID</th>
                  <th className="p-3">Name_of_Product</th>
                  <th className="p-3">Items_Sold</th>
                  <th className="p-3">Price</th>
                  <th className="p-3">Cost</th>
                  <th className="p-3">Revenue (Sold×Price)</th>
                  <th className="p-3">Net_Profit</th>
                </tr>
              </thead>
              <tbody className="divide-y">
                {displayFinancialMetrics.map((row) => (
                  <tr key={row.productId} className="hover:bg-gray-50 transition-colors">
                    <td className="p-3 font-bold text-gray-700">{row.productId}</td>
                    <td className="p-3 font-semibold text-gray-900">{row.productName}</td>
                    <td className="p-3 text-gray-700">{row.itemsSold}</td>
                    <td className="p-3 text-gray-700">${row.itemPrice.toFixed(2)}</td>
                    <td className="p-3 text-gray-700">${row.itemCost.toFixed(2)}</td>
                    <td className="p-3 font-bold text-gray-900">${row.revenue.toFixed(2)}</td>
                    <td className={`p-3 font-bold ${row.netProfit >= 0 ? 'text-green-700' : 'text-red-600'}`}>${row.netProfit.toFixed(2)}</td>
                  </tr>
                ))}
                {displayFinancialMetrics.length === 0 && (
                  <tr>
                    <td colSpan={7} className="p-6 text-center text-gray-500">No products available yet.</td>
                  </tr>
                )}
              </tbody>
            </table>
          </div>
          <div className="p-4 border-t bg-gray-50 flex justify-end gap-8">
            <div className="text-right">
              <p className="text-[10px] font-bold uppercase text-gray-500">Total Revenue</p>
              <p className="text-base font-black text-gray-900">${totalSalesValue.toLocaleString(undefined, { minimumFractionDigits: 2, maximumFractionDigits: 2 })}</p>
            </div>
            <div className="text-right">
              <p className="text-[10px] font-bold uppercase text-gray-500">Total Net Profit</p>
              <p className={`text-base font-black ${profit >= 0 ? 'text-green-700' : 'text-red-600'}`}>${profit.toLocaleString(undefined, { minimumFractionDigits: 2, maximumFractionDigits: 2 })}</p>
            </div>
          </div>
        </div>
      )}

      {activeTab === 'inventory' && (
        <div className="bg-white rounded-xl border overflow-hidden animate-fade-in-up min-w-0">
          <div className="p-4 border-b bg-gray-50 flex flex-col gap-3">
            <div className="flex flex-wrap justify-between items-center gap-2">
              <div>
                <h3 className="font-black uppercase text-sm text-gray-700">Inventory</h3>
                <p className="text-[10px] text-gray-500 font-semibold uppercase">All sections connected to database</p>
              </div>
              <span className="text-[10px] bg-gray-900 text-white px-3 py-1 rounded-full font-bold uppercase">{inventoryProducts.length} Total</span>
            </div>
            <div className="relative w-full sm:max-w-xs min-w-0">
              <Search size={14} className="absolute left-3 top-1/2 -translate-y-1/2 text-gray-400" />
              <input
                type="text"
                value={inventorySearchQuery}
                onChange={(e) => setInventorySearchQuery(e.target.value)}
                placeholder="Search by ID, name, brand, type..."
                className="w-full pl-8 pr-8 py-2 bg-white border rounded-lg text-xs font-semibold outline-none focus:ring-2 focus:ring-orange-500 min-w-0"
              />
              {inventorySearchQuery && (
                <button
                  type="button"
                  onClick={() => setInventorySearchQuery('')}
                  aria-label="Clear search"
                  className="absolute right-2 top-1/2 -translate-y-1/2 text-gray-400 hover:text-gray-600"
                >
                  <X size={14} />
                </button>
              )}
            </div>
            <div className="flex flex-wrap gap-2">
              {inventorySections.map(section => {
                const label = section === 'ComingSoon' ? 'T-shirts & Hoodies (Soon)' : section;
                const count = section === 'All'
                  ? products.length
                  : section === 'ComingSoon'
                    ? products.filter(p => /t-?shirt|hoodie/i.test(p.type)).length
                    : products.filter(p => p.category === section).length;
                return (
                  <button
                    key={section}
                    onClick={() => setInventorySection(section)}
                    className={`px-3 py-1.5 rounded-md text-xs font-bold border transition-colors ${inventorySection === section ? 'bg-gray-900 text-white border-gray-900' : 'bg-white text-gray-700 border-gray-200 hover:bg-gray-50'}`}
                  >
                    {label} ({count})
                  </button>
                );
              })}
            </div>
            <div className="flex flex-wrap items-center gap-2 pt-2 border-t border-gray-100">
              {selectedProductIds.size > 0 && (
                <>
                  <span className="text-[10px] bg-orange-600 text-white px-3 py-1.5 rounded-full font-black uppercase">{selectedProductIds.size} Selected</span>
                  <button type="button" onClick={openBulkEdit} className="px-3 py-2 rounded-lg border border-gray-200 text-gray-700 text-[10px] font-black uppercase flex items-center gap-2 hover:bg-gray-50">
                    <Edit2 size={14} /> Bulk Edit
                  </button>
                  <button type="button" disabled={isBulkSaving} onClick={handleBulkDelete} className="px-3 py-2 rounded-lg border border-red-200 text-red-600 text-[10px] font-black uppercase flex items-center gap-2 hover:bg-red-50 disabled:opacity-50">
                    <Trash2 size={14} /> Delete Selected
                  </button>
                  <button type="button" onClick={clearSelection} className="px-3 py-2 rounded-lg border border-gray-200 text-gray-500 text-[10px] font-black uppercase hover:bg-gray-50">
                    Clear
                  </button>
                  <span className="w-px h-5 bg-gray-200" />
                </>
              )}
              <button type="button" onClick={() => setIsImportPanelOpen((prev) => !prev)} className="px-3 py-2 rounded-lg border border-gray-200 text-gray-700 text-[10px] font-black uppercase flex items-center gap-2 hover:bg-gray-50">
                <Upload size={14} /> {isImportPanelOpen ? 'Close Import' : 'Import'}
              </button>
              <button type="button" onClick={() => handleExportInventory('csv')} className="px-3 py-2 rounded-lg border border-gray-200 text-gray-700 text-[10px] font-black uppercase flex items-center gap-2 hover:bg-gray-50">
                <Download size={14} /> {selectedProductIds.size > 0 ? 'Export Selected CSV' : 'Export All CSV'}
              </button>
              <button type="button" onClick={() => handleExportInventory('xlsx')} className="px-3 py-2 rounded-lg border border-gray-200 text-gray-700 text-[10px] font-black uppercase flex items-center gap-2 hover:bg-gray-50">
                <Download size={14} /> Excel
              </button>
            </div>
          </div>

          {isImportPanelOpen && (
            <div className="p-4 border-b bg-gray-50/60 space-y-4">
              <div className="text-xs text-gray-600 space-y-1">
                <p className="text-[10px] font-black uppercase text-gray-500">Required columns</p>
                <p>SKU, Product Name, Category, Type, Price, Stock, Sizes, Description.</p>
                <p className="text-[10px] font-black uppercase text-gray-500 mt-2">Optional columns</p>
                <p>Brand, Cost, Gender, Status, Images, Colors, Size Stock, Original Price, On Sale.</p>
              </div>
              <div className="flex flex-wrap gap-2">
                <button type="button" onClick={() => handleDownloadTemplate('csv')} className="px-3 py-2 rounded-lg border border-gray-200 text-gray-700 text-[10px] font-black uppercase flex items-center gap-2 hover:bg-gray-50">
                  <Download size={14} /> CSV Template
                </button>
                <button type="button" onClick={() => handleDownloadTemplate('xlsx')} className="px-3 py-2 rounded-lg border border-gray-200 text-gray-700 text-[10px] font-black uppercase flex items-center gap-2 hover:bg-gray-50">
                  <Download size={14} /> Excel Template
                </button>
                <button type="button" onClick={() => importFileRef.current?.click()} className="px-3 py-2 rounded-lg border border-gray-200 text-gray-700 text-[10px] font-black uppercase flex items-center gap-2 hover:bg-gray-50">
                  <Upload size={14} /> Select File
                </button>
                <input ref={importFileRef} type="file" accept=".csv,.xls,.xlsx" hidden onChange={handleImportFileChange} />
              </div>

              {importFileName && (
                <p className="text-[10px] font-black uppercase text-gray-500">Selected: {importFileName}</p>
              )}

              <div className="flex flex-col md:flex-row md:items-center gap-3">
                <label className="text-[10px] font-black uppercase text-gray-500">Duplicate SKU behavior</label>
                <select
                  value={duplicateBehavior}
                  onChange={(e) => setDuplicateBehavior(e.target.value as 'update' | 'skip')}
                  className="px-3 py-2 rounded-lg border border-gray-200 text-gray-700 text-[10px] font-black uppercase"
                >
                  <option value="update">Update existing products</option>
                  <option value="skip">Skip duplicates</option>
                </select>
              </div>

              {importErrors.length > 0 && (
                <div className="border border-red-200 bg-red-50 rounded-xl p-3 space-y-1">
                  {importErrors.map((error) => (
                    <p key={error} className="text-[10px] font-bold text-red-700">{error}</p>
                  ))}
                </div>
              )}

              {importPreviewRows.length > 0 && (
                <div className="bg-white border rounded-2xl overflow-hidden">
                  <div className="p-3 border-b bg-gray-50 flex items-center justify-between">
                    <p className="text-[10px] font-bold uppercase text-gray-500">Preview</p>
                    <span className="text-[10px] bg-gray-900 text-white px-3 py-1 rounded-full font-bold uppercase">
                      {importableRows.length} Ready
                    </span>
                  </div>
                  <div className="overflow-x-auto">
                    <table className="w-full text-left text-[11px] min-w-[700px]">
                      <thead className="bg-gray-100 uppercase font-black text-gray-500 border-b">
                        <tr>
                          <th className="p-3">Row</th>
                          <th className="p-3">SKU</th>
                          <th className="p-3">Product</th>
                          <th className="p-3">Category</th>
                          <th className="p-3">Price</th>
                          <th className="p-3">Stock</th>
                          <th className="p-3">Status</th>
                          <th className="p-3">Notes</th>
                        </tr>
                      </thead>
                      <tbody className="divide-y">
                        {importPreviewRows.slice(0, 50).map((row) => (
                          <tr key={`${row.rowNumber}-${row.sku}`} className="hover:bg-gray-50">
                            <td className="p-3 text-gray-600">{row.rowNumber}</td>
                            <td className="p-3 font-semibold text-gray-900">{row.sku || '-'}</td>
                            <td className="p-3 text-gray-700 max-w-[160px] truncate">{row.productName || '-'}</td>
                            <td className="p-3 text-gray-700">{row.category || '-'}</td>
                            <td className="p-3 text-gray-700">${Number(row.price || 0).toFixed(2)}</td>
                            <td className="p-3 text-gray-700">{row.stock}</td>
                            <td className="p-3">
                              {row.errors.length > 0 ? (
                                <span className="px-2 py-1 rounded text-[10px] font-bold uppercase bg-red-100 text-red-700">Invalid</span>
                              ) : row.duplicateSku ? (
                                <span className="px-2 py-1 rounded text-[10px] font-bold uppercase bg-amber-100 text-amber-700">Duplicate</span>
                              ) : (
                                <span className="px-2 py-1 rounded text-[10px] font-bold uppercase bg-green-100 text-green-700">Ready</span>
                              )}
                            </td>
                            <td className="p-3 text-gray-500 max-w-[200px] truncate">
                              {row.errors.length > 0 ? row.errors.join(' ') : row.duplicateSku ? 'Existing SKU' : 'OK'}
                            </td>
                          </tr>
                        ))}
                      </tbody>
                    </table>
                  </div>
                  {importPreviewRows.length > 50 && (
                    <div className="p-3 text-[10px] font-bold uppercase text-gray-500 bg-gray-50 border-t">
                      Showing first 50 rows. Import will include all valid rows.
                    </div>
                  )}
                </div>
              )}

              <div className="flex flex-col md:flex-row md:items-center gap-3">
                <button
                  type="button"
                  disabled={importableRows.length === 0 || isImporting}
                  onClick={handleConfirmImport}
                  className={`px-6 py-3 rounded-xl text-[11px] font-black uppercase tracking-widest transition-all shadow-xl ${importableRows.length === 0 || isImporting ? 'bg-gray-200 text-gray-500 cursor-not-allowed shadow-transparent' : 'bg-orange-600 text-white hover:bg-orange-700 shadow-orange-600/20'}`}
                >
                  {isImporting ? 'Importing...' : `Import ${importableRows.length} Items`}
                </button>
                <button
                  type="button"
                  onClick={resetImportState}
                  className="px-4 py-2 rounded-lg border border-gray-200 text-gray-700 text-[10px] font-black uppercase hover:bg-gray-50"
                >
                  Clear Preview
                </button>
                {importSummary && (
                  <div className="text-[10px] font-black uppercase text-gray-500">
                    Imported: {importSummary.imported} · Updated: {importSummary.updated} · Skipped: {importSummary.skipped} · Errors: {importSummary.errors}
                  </div>
                )}
              </div>
            </div>
          )}

          <div className="overflow-x-auto">
            <table className="w-full text-left text-[11px] min-w-[1280px]">
              <thead className="bg-gray-100 uppercase font-black text-gray-500 border-b">
                <tr>
                  <th className="p-3 w-9">
                    <input
                      type="checkbox"
                      checked={isAllCurrentPageSelected}
                      onChange={toggleSelectAllCurrentPage}
                      aria-label="Select all products on this page"
                    />
                  </th>
                  <th className="p-3">
                    <button onClick={() => cycleSort('Product_ID')} className="flex items-center gap-1 hover:text-gray-900 transition-colors whitespace-nowrap">
                      Product_ID
                      <span className="text-[10px] leading-none">{inventorySort?.col === 'Product_ID' ? (inventorySort.dir === 'asc' ? '▲' : '▼') : '⇅'}</span>
                    </button>
                  </th>
                  <th className="p-3">
                    <button onClick={() => cycleSort('productName')} className="flex items-center gap-1 hover:text-gray-900 transition-colors whitespace-nowrap">
                      Product
                      <span className="text-[10px] leading-none">{inventorySort?.col === 'productName' ? (inventorySort.dir === 'asc' ? '▲' : '▼') : '⇅'}</span>
                    </button>
                  </th>
                  <th className="p-3 whitespace-nowrap">
                    <button onClick={() => cycleSort('category')} className="flex items-center gap-1 hover:text-gray-900 transition-colors whitespace-nowrap">
                      Category
                      <span className="text-[10px] leading-none">{inventorySort?.col === 'category' ? (inventorySort.dir === 'asc' ? '▲' : '▼') : '⇅'}</span>
                    </button>
                  </th>
                  <th className="p-3 whitespace-nowrap">Type</th>
                  <th className="p-3 whitespace-nowrap">Sizes</th>
                  <th className="p-3">Colors</th>
                  <th className="p-3 whitespace-nowrap">Price</th>
                  <th className="p-3 whitespace-nowrap">Stock</th>
                  <th className="p-3 whitespace-nowrap">Status</th>
                  <th className="p-3">Description</th>
                  <th className="p-3 text-right whitespace-nowrap">Actions</th>
                </tr>
              </thead>
              <tbody className="divide-y">
                {pagedInventoryProducts.map(p => {
                  const totals = getProductStockTotals(p);
                  const computedLeft = totals.left;
                  const stockStatus = computedLeft <= 0 ? 'Out of Stock' : computedLeft < 10 ? 'Low Stock' : 'Healthy';
                  const normalizedStatus = p.status || stockStatus;
                  const rowColors = getProductColorTokens(p);
                  return (
                    <tr key={p.Product_ID} className={`hover:bg-gray-50 transition-colors ${selectedProductIds.has(p.Product_ID) ? 'bg-orange-50/40' : ''}`}>
                      <td className="p-3">
                        <input
                          type="checkbox"
                          checked={selectedProductIds.has(p.Product_ID)}
                          onChange={() => toggleProductSelected(p.Product_ID)}
                          aria-label={`Select ${p.Product_ID}`}
                        />
                      </td>
                      <td className="p-3 font-bold text-gray-700 whitespace-nowrap">{p.Product_ID}</td>
                      <td className="p-3 max-w-[280px]">
                        <div className="flex items-center gap-2 min-w-0">
                          <div className="w-10 h-10 rounded border overflow-hidden bg-gray-50 flex items-center justify-center flex-shrink-0">
                            <SafeImage src={p.image} className="w-full h-full object-contain p-0.5" alt={p.name} />
                          </div>
                          <div className="min-w-0">
                            <p className="font-semibold text-gray-900 truncate">{p.brandName || splitDisplayName(p.name).brand || '-'} {p.productName || splitDisplayName(p.name).product || ''}</p>
                            <p className="text-[9px] text-gray-400 uppercase font-bold truncate">{normalizeGender(p.gender)}</p>
                          </div>
                        </div>
                      </td>
                      <td className="p-3 text-gray-700 whitespace-nowrap">{p.category}</td>
                      <td className="p-3 text-gray-700 whitespace-nowrap max-w-[160px] truncate">{p.type}</td>
                      <td className="p-3 text-gray-700 max-w-[160px] truncate">{p.sizes.join(', ') || '-'}</td>
                      <td className="p-3">
                        <div className="flex flex-wrap gap-1 max-w-[180px]">
                          {rowColors.length ? (
                            rowColors.map((c) => (
                              <span key={c} className="inline-block bg-orange-50 text-orange-800 px-1.5 py-0.5 rounded text-[9px] font-bold uppercase">
                                {c}
                              </span>
                            ))
                          ) : (
                            <span className="text-gray-400 text-[10px]">—</span>
                          )}
                        </div>
                      </td>
                      <td className="p-3 whitespace-nowrap">
                        <p className="font-bold text-gray-900">${p.price}</p>
                        <p className="text-[9px] text-gray-400">cost ${p.cost}</p>
                      </td>
                      <td className="p-3 whitespace-nowrap">
                        <p className="font-bold text-orange-600">{computedLeft} left</p>
                        <p className="text-[9px] text-blue-600 font-bold">{totals.sold} sold</p>
                      </td>
                      <td className="p-3 whitespace-nowrap">
                        <span className={`px-2 py-1 rounded text-[10px] font-bold uppercase ${normalizedStatus === 'Out of Stock' ? 'bg-red-50 text-red-700' : 'bg-blue-50 text-blue-700'}`}>
                          {normalizedStatus}
                        </span>
                      </td>
                      <td className="p-3 max-w-[320px]">
                        <p className="text-[10px] text-gray-600 truncate">{p.description || '-'}</p>
                      </td>
                      <td className="p-3 text-right">
                        <div className="flex justify-end gap-1">
                          <button onClick={() => { setEditMode(p); setUploadedImageFiles([]); setUploadedImagePreviews([]); setImageValidationErrors([]); }} className="p-2 hover:bg-orange-50 text-gray-400 hover:text-orange-600 rounded-lg transition-colors"><Edit2 size={14} /></button>
                          <button onClick={async () => {
                            if(confirm('Permanently erase this asset?')) {
                              try {
                                await deleteProduct(p.Product_ID);
                                const refreshedProducts = await getProducts();
                                setProducts(refreshedProducts);
                              } catch (error: any) {
                                console.error('Error deleting product:', error);
                                const msg = error?.message || 'Failed to delete product. Please try again.';
                                alert(msg);
                              }
                            }
                          }} className="p-2 hover:bg-red-50 text-gray-400 hover:text-red-600 rounded-lg transition-colors"><Trash2 size={14} /></button>
                        </div>
                      </td>
                    </tr>
                  );
                })}
                {pagedInventoryProducts.length === 0 && (
                  <tr>
                    <td colSpan={12} className="p-6 text-center text-gray-500 font-semibold">
                      {inventorySection === 'ComingSoon'
                        ? 'No T-shirt or Hoodie products found yet. Add items with type containing "tshirt", "t-shirt", or "hoodie".'
                        : 'No products in this section.'}
                    </td>
                  </tr>
                )}
              </tbody>
            </table>
          </div>
          {inventoryProducts.length > inventoryPageSize && (
            <div className="px-4 py-3 border-t bg-gray-50 flex items-center justify-between">
              <p className="text-[10px] font-black uppercase tracking-wider text-gray-500">Page {inventoryPage} / {inventoryTotalPages}</p>
              <div className="flex items-center gap-2">
                <button
                  type="button"
                  disabled={inventoryPage <= 1}
                  onClick={() => setInventoryPage((prev) => Math.max(1, prev - 1))}
                  className="px-3 py-1.5 text-[10px] font-black uppercase rounded-lg border border-gray-200 text-gray-600 disabled:opacity-40"
                >
                  Prev
                </button>
                <button
                  type="button"
                  disabled={inventoryPage >= inventoryTotalPages}
                  onClick={() => setInventoryPage((prev) => Math.min(inventoryTotalPages, prev + 1))}
                  className="px-3 py-1.5 text-[10px] font-black uppercase rounded-lg border border-gray-200 text-gray-600 disabled:opacity-40"
                >
                  Next
                </button>
              </div>
            </div>
          )}
        </div>
      )}

      {activeTab === 'add' && (
        <div className="max-w-4xl mx-auto bg-white p-6 rounded-2xl shadow-xl border animate-fade-in-up">
          <h3 className="font-black mb-6 uppercase flex items-center gap-2 text-lg italic text-black">
            {editMode ? <Edit2 size={24} className="text-orange-600" /> : <Plus size={24} className="text-orange-600" />} {editMode ? 'Update Existing Asset' : 'Create New Authentic Asset'}
          </h3>
          <form onSubmit={saveProduct} className="grid grid-cols-1 md:grid-cols-2 gap-8">
            <div className="space-y-6">
              <div>
                <label className="text-[10px] font-black uppercase text-gray-400 ml-1">Product_ID</label>
                <input
                  value={editMode?.Product_ID || generateNextProductId()}
                  readOnly
                  className="w-full p-4 bg-gray-100 border rounded-2xl text-sm font-bold text-gray-600 outline-none"
                />
              </div>
              <div>
                <label className="text-[10px] font-black uppercase text-gray-400 ml-1">Naming</label>
                <div className="grid grid-cols-1 md:grid-cols-2 gap-3">
                  <input
                    name="brandName"
                    value={brandName}
                    onChange={(e) => setBrandName(e.target.value)}
                    placeholder="Brand Name"
                    className="w-full p-4 bg-gray-50 border rounded-2xl text-sm font-bold focus:ring-2 focus:ring-orange-500 outline-none"
                    required
                  />
                  <input
                    name="productName"
                    value={productName}
                    onChange={(e) => setProductName(e.target.value)}
                    placeholder="Product Name"
                    className="w-full p-4 bg-gray-50 border rounded-2xl text-sm font-bold focus:ring-2 focus:ring-orange-500 outline-none"
                    required
                  />
                </div>
              </div>
              <div className="grid grid-cols-2 gap-4">
                <div>
                  <label className="text-[10px] font-black uppercase text-gray-400 ml-1">Category</label>
                  <select value={formCategory} onChange={(e) => {setFormCategory(e.target.value as Category); setSelectedSizes([]);}} className="w-full p-4 bg-gray-50 border rounded-2xl text-sm font-bold outline-none">
                    {Object.values(Category).map(c => <option key={c} value={c}>{c}</option>)}
                  </select>
                </div>
                <div>
                  <label className="text-[10px] font-black uppercase text-gray-400 ml-1">Gender</label>
                  <select name="gender" defaultValue={editMode?.gender || 'Unisex'} className="w-full p-4 bg-gray-50 border rounded-2xl text-sm font-bold outline-none">
                    {GENDER_OPTIONS.map((g) => <option key={g} value={g}>{g}</option>)}
                  </select>
                </div>
              </div>
              <div className="grid grid-cols-1 gap-4">
                <div>
                  <label className="text-[10px] font-black uppercase text-gray-400 ml-1">Type/Style</label>
                  <input name="type" defaultValue={editMode?.type} placeholder="Casual, Vintage..." className="w-full p-4 bg-gray-50 border rounded-2xl text-sm font-bold outline-none" required />
                  <label className="text-[10px] font-black uppercase text-gray-400 ml-1 mt-4 block">Colors (tags)</label>
                  <input
                    type="text"
                    value={formColors}
                    onChange={(e) => setFormColors(e.target.value)}
                    placeholder="e.g. orange, black, white"
                    className="w-full p-4 bg-gray-50 border rounded-2xl text-sm font-bold focus:ring-2 focus:ring-orange-500 outline-none"
                  />
                </div>
              </div>
              <div>
                <label className="text-[10px] font-black uppercase text-gray-400 ml-1">Economics</label>
                <div className="grid grid-cols-2 gap-4">
                  <input name="cost" type="number" step="0.01" defaultValue={editMode?.cost} placeholder="Cost ($)" className="w-full p-4 bg-gray-50 border rounded-2xl text-sm font-bold outline-none" required />
                  <input name="price" type="number" step="0.01" defaultValue={editMode?.price} placeholder="Price ($)" className="w-full p-4 bg-gray-50 border rounded-2xl text-sm font-bold outline-none" required />
                </div>
              </div>
              <div>
                <label className="text-[10px] font-black uppercase text-gray-400 ml-1 block mb-2">Size Stock</label>
                <div className="space-y-2 p-3 rounded-2xl bg-gray-50 border">
                  {selectedSizes.length === 0 ? (
                    <p className="text-[10px] text-gray-400 font-semibold">Select sizes first to configure stock per size.</p>
                  ) : (
                    selectedSizes.map((size) => {
                      const current = formSizeStock.find((entry) => entry.size === size)?.stock ?? 0;
                      return (
                        <div key={size} className="flex items-center gap-3">
                          <span className="w-16 text-[10px] font-black uppercase tracking-wider text-gray-500">{size}</span>
                          <input
                            type="number"
                            min="0"
                            value={current}
                            onChange={(event) => {
                              const nextStock = Math.max(0, Math.floor(Number(event.target.value || 0)));
                              setFormSizeStock((prev) => prev.map((entry) => entry.size === size ? { ...entry, stock: nextStock } : entry));
                            }}
                            className="flex-1 p-3 bg-white border rounded-xl text-sm font-bold outline-none"
                            placeholder="0"
                          />
                        </div>
                      );
                    })
                  )}
                </div>
                <div className="mt-3 p-4 rounded-xl bg-orange-50 border border-orange-100 flex items-center justify-between">
                  <span className="text-[10px] font-black uppercase tracking-wider text-orange-600/70">Calculated Final Inventory</span>
                  <span className="text-xl font-black text-orange-600">{formSizeStock.reduce((total, entry) => total + Math.max(0, Number(entry.stock || 0)), 0)} pieces left</span>
                </div>
              </div>
            </div>

            <div className="space-y-6">
              <div>
                <label className="text-[10px] font-black uppercase text-gray-400 ml-1">Asset Description</label>
                <textarea name="description" defaultValue={editMode?.description} placeholder="Enter full product details and authenticity notes..." rows={4} className="w-full p-4 bg-gray-50 border rounded-2xl text-sm font-bold focus:ring-2 focus:ring-orange-500 outline-none" required></textarea>
              </div>
              <div>
                <label className="text-[10px] font-black uppercase text-gray-400 ml-1 block mb-2">Sale Pricing</label>
                <div className="grid grid-cols-2 gap-4">
                  <input name="original_price" type="number" step="0.01" defaultValue={editMode?.originalPrice ?? ''} placeholder="Original Price" className="w-full p-4 bg-gray-50 border rounded-2xl text-sm font-bold outline-none" />
                  <label className="flex items-center gap-2 px-4 py-3 bg-gray-50 border rounded-2xl text-sm font-bold text-gray-600">
                    <input name="on_sale" type="checkbox" defaultChecked={Boolean(editMode?.onSale)} className="h-4 w-4 accent-orange-600" />
                    On Sale
                  </label>
                </div>
              </div>
              <div>
                <label className="text-[10px] font-black uppercase text-gray-400 ml-1 block mb-2">Tags</label>
                {allTags.length === 0 ? (
                  <p className="text-[10px] text-gray-400 font-semibold p-3 bg-gray-50 border rounded-2xl">
                    No tags yet. Create one in the Admin "Tags" section, then come back here to assign it.
                  </p>
                ) : (
                  <div className="flex flex-wrap gap-2 p-3 bg-gray-50 border rounded-2xl">
                    {allTags.map((tag) => {
                      const isSelected = formTagIds.includes(tag.id);
                      return (
                        <button
                          key={tag.id}
                          type="button"
                          onClick={() => setFormTagIds((prev) => isSelected ? prev.filter((id) => id !== tag.id) : [...prev, tag.id])}
                          className={`px-3 py-1.5 rounded-full text-[10px] font-black uppercase tracking-wider border transition-all ${isSelected ? 'bg-orange-600 text-white border-orange-600' : 'bg-white text-gray-600 border-gray-200 hover:border-orange-400'}`}
                        >
                          {tag.name}
                        </button>
                      );
                    })}
                  </div>
                )}
              </div>
              <div>
                <label className="text-[10px] font-black uppercase text-gray-400 ml-1 block mb-2">Variant Selection ({formCategory})</label>
                <div className="mb-2 flex items-center justify-between">
                  <p className="text-[10px] font-bold uppercase text-gray-500 tracking-wider">{SIZE_OPTIONS[formCategory].length} Checkboxes</p>
                  <div className="flex items-center gap-2">
                    <button
                      type="button"
                      onClick={() => setSelectedSizes([...SIZE_OPTIONS[formCategory]])}
                      className="px-2.5 py-1 text-[9px] font-black uppercase rounded-lg border border-gray-200 text-gray-600 hover:bg-gray-100"
                    >
                      Select All
                    </button>
                    <button
                      type="button"
                      onClick={() => setSelectedSizes([])}
                      className="px-2.5 py-1 text-[9px] font-black uppercase rounded-lg border border-gray-200 text-gray-600 hover:bg-gray-100"
                    >
                      Clear
                    </button>
                  </div>
                </div>
                <div className={`grid ${isShoesCategory ? 'grid-cols-4 md:grid-cols-6' : 'grid-cols-4'} gap-1.5 max-h-64 overflow-y-auto p-2 bg-gray-50 border rounded-2xl shadow-inner`}>
                  {SIZE_OPTIONS[formCategory].map((size) => (
                    <label key={size} className={`flex items-center justify-center p-2 border rounded-xl text-[9px] cursor-pointer transition-all font-black select-none min-h-9 ${selectedSizes.includes(size) ? 'bg-orange-600 text-white border-orange-600' : 'bg-white border-gray-100 text-gray-500 hover:border-orange-500'}`}>
                      <input type="checkbox" checked={selectedSizes.includes(size)} onChange={() => toggleSize(size)} className="hidden" />
                      {size}
                    </label>
                  ))}
                </div>
                {isShoesCategory && (
                  <p className="mt-2 text-[10px] text-gray-500 font-semibold">
                    Shoe matrix includes 35 to 50 with variants: base, (1/3), (1/2), (2/3).
                  </p>
                )}
              </div>
              <div>
                <label className="text-[10px] font-black uppercase text-gray-400 ml-1">Status</label>
                <select name="status" defaultValue={editMode?.status || 'Active'} className="w-full p-4 bg-gray-50 border rounded-2xl text-sm font-bold outline-none">
                  <option value="Active">Active</option>
                  <option value="Discontinued">Discontinued</option>
                  <option value="Out of Stock">Out of Stock</option>
                  <option value="Coming Soon">Coming Soon</option>
                </select>
              </div>
              <div>
                <label className="text-[10px] font-black uppercase text-gray-400 ml-1">Asset Photography</label>
                <div className="flex gap-2">
                  <button type="button" onClick={() => fileRef.current?.click()} className="flex-1 bg-gray-100 py-3 rounded-2xl text-[10px] font-black flex items-center justify-center gap-2 hover:bg-gray-200 uppercase tracking-widest"><Upload size={14} /> Picture</button>
                  <input name="image" placeholder="Primary image URL" defaultValue={editMode?.image} className="flex-[2] p-4 bg-gray-50 border rounded-2xl text-sm font-bold outline-none" />
                  <input type="file" ref={fileRef} hidden accept="image/*" multiple onChange={handleFile} />
                </div>
                <textarea
                  name="images"
                  value={formImagesText}
                  onChange={(event) => setFormImagesText(event.target.value)}
                  placeholder="Additional image URLs separated by commas"
                  rows={3}
                  className="mt-2 w-full p-4 bg-gray-50 border rounded-2xl text-sm font-bold focus:ring-2 focus:ring-orange-500 outline-none"
                />
                {parseImageUrlTokens(formImagesText).length > 0 && (
                  <div className="mt-2 grid grid-cols-4 gap-2">
                    {parseImageUrlTokens(formImagesText).map((url, index) => (
                      <div key={url + index} className="relative rounded-xl border overflow-hidden bg-gray-50 aspect-square">
                        <SafeImage src={url} alt={`URL preview ${index + 1}`} className="w-full h-full object-cover" />
                        <button
                          type="button"
                          onClick={() => {
                            const next = parseImageUrlTokens(formImagesText).filter((_, urlIndex) => urlIndex !== index);
                            setFormImagesText(next.join(', '));
                          }}
                          className="absolute top-1 right-1 w-5 h-5 rounded-full bg-black/70 text-white text-[10px]"
                          aria-label="Remove URL image"
                        >
                          x
                        </button>
                      </div>
                    ))}
                  </div>
                )}
                {uploadedImagePreviews.length > 0 && (
                  <div className="mt-2 grid grid-cols-4 gap-2">
                    {uploadedImagePreviews.map((preview, index) => (
                      <div key={preview + index} className="relative rounded-xl border overflow-hidden bg-gray-50 aspect-square">
                        <SafeImage src={preview} alt={`Upload preview ${index + 1}`} className="w-full h-full object-cover" />
                        <button
                          type="button"
                          onClick={() => {
                            setUploadedImageFiles((prev) => prev.filter((_, fileIndex) => fileIndex !== index));
                            setUploadedImagePreviews((prev) => {
                              const target = prev[index];
                              if (target && target.startsWith('blob:')) URL.revokeObjectURL(target);
                              return prev.filter((_, previewIndex) => previewIndex !== index);
                            });
                          }}
                          className="absolute top-1 right-1 w-5 h-5 rounded-full bg-black/70 text-white text-[10px]"
                          aria-label="Remove uploaded image"
                        >
                          x
                        </button>
                      </div>
                    ))}
                  </div>
                )}
                {imageValidationErrors.length > 0 && (
                  <div className="mt-2 p-2 rounded-xl border border-red-200 bg-red-50 space-y-1">
                    {imageValidationErrors.map((errorText) => (
                      <p key={errorText} className="text-[10px] font-bold text-red-700">{errorText}</p>
                    ))}
                  </div>
                )}
                {isUploadingImages && (
                  <p className="mt-2 text-[10px] font-black uppercase text-orange-600 tracking-wider">Uploading images...</p>
                )}
              </div>
              <div className="flex gap-4 pt-4">
                <button type="submit" className="flex-1 bg-orange-600 text-white py-3 rounded-xl font-black uppercase tracking-widest hover:bg-orange-700 hover:scale-[1.02] transition-all shadow-xl shadow-orange-600/20 text-sm">{editMode ? 'Commit Changes' : 'Publish Asset'}</button>
                {editMode && <button type="button" onClick={() => {setEditMode(null); setUploadedImageFiles([]); setUploadedImagePreviews([]); setImageValidationErrors([]); setFormImagesText(''); setFormSizeStock([]); setBrandName(''); setProductName(''); setActiveTab('inventory');}} className="px-8 bg-gray-100 rounded-3xl font-black uppercase text-[10px] tracking-widest">Cancel</button>}
              </div>
            </div>
          </form>
        </div>
      )}

      {activeTab === 'orders' && (
        <div className="space-y-6 animate-fade-in-up">
          {ordersActionError && (
            <div className="bg-red-50 border border-red-200 text-red-700 px-4 py-3 rounded-xl text-xs font-bold uppercase tracking-widest">
              {ordersActionError}
            </div>
          )}

          {isLoading ? (
            <div className="text-center py-16 bg-white rounded-2xl border border-dashed text-gray-400 font-black uppercase tracking-[0.2em] text-sm">
              Loading orders...
            </div>
          ) : orders.length === 0 ? (
            <div className="text-center py-16 bg-white rounded-2xl border border-dashed text-gray-300 font-black uppercase italic tracking-[0.2em] text-sm">
              No Distribution Records Found
            </div>
          ) : selectedOrder ? (
            <div className="bg-white border rounded-2xl p-6 space-y-6">
              <div className="flex flex-col md:flex-row md:items-center md:justify-between gap-3">
                <div>
                  <p className="text-[10px] font-bold uppercase text-gray-500">Order Details</p>
                  <h3 className="text-lg font-black uppercase text-gray-900">{selectedOrder.customerName}</h3>
                </div>
                <button
                  type="button"
                  onClick={() => setSelectedOrderId(null)}
                  className="px-4 py-2 rounded-lg border border-gray-200 text-gray-700 text-[11px] font-black uppercase hover:bg-gray-50"
                >
                  Back to Orders
                </button>
              </div>

              <div className="grid grid-cols-1 lg:grid-cols-[1fr_280px] gap-6">
                <div className="space-y-6">
                  <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
                    <div className="p-4 rounded-xl border bg-gray-50">
                      <p className="text-[10px] font-bold uppercase text-gray-500">Order ID</p>
                      <p className="text-sm font-black text-gray-900 break-all">{selectedOrder.id}</p>
                    </div>
                    <div className="p-4 rounded-xl border bg-gray-50">
                      <p className="text-[10px] font-bold uppercase text-gray-500">Status</p>
                      <p className="text-sm font-black text-gray-900">{normalizeOrderStatus(selectedOrder.status)}</p>
                    </div>
                    <div className="p-4 rounded-xl border bg-gray-50">
                      <p className="text-[10px] font-bold uppercase text-gray-500">Date</p>
                      <p className="text-sm font-black text-gray-900">{new Date(selectedOrder.date).toLocaleString()}</p>
                    </div>
                    <div className="p-4 rounded-xl border bg-gray-50">
                      <p className="text-[10px] font-bold uppercase text-gray-500">Payment</p>
                      <p className="text-sm font-black text-gray-900">{getOrderPaymentStatus(selectedOrder)}</p>
                    </div>
                  </div>

                  <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
                    <div className="p-4 rounded-xl border">
                      <p className="text-[10px] font-bold uppercase text-gray-500">Contact</p>
                      <p className="text-sm font-black text-gray-900">{selectedOrder.customerPhone}</p>
                      <p className="text-xs text-gray-500">{selectedOrder.customerEmail}</p>
                    </div>
                    <div className="p-4 rounded-xl border">
                      <p className="text-[10px] font-bold uppercase text-gray-500">Shipping</p>
                      <p className="text-xs text-gray-700">
                        {selectedOrder.governorate}, {selectedOrder.district}, {selectedOrder.village}
                      </p>
                      <p className="text-xs text-gray-700">{selectedOrder.addressDetails}</p>
                    </div>
                  </div>

                  <div className="border rounded-xl overflow-hidden">
                    <div className="px-4 py-3 bg-gray-50 border-b">
                      <p className="text-[10px] font-bold uppercase text-gray-500">Items</p>
                    </div>
                    <div className="overflow-x-auto">
                      <table className="w-full text-left text-[11px] min-w-[520px]">
                        <thead className="bg-white uppercase font-black text-gray-500 border-b">
                          <tr>
                            <th className="p-3">Product</th>
                            <th className="p-3">SKU</th>
                            <th className="p-3">Size</th>
                            <th className="p-3">Qty</th>
                            <th className="p-3">Price</th>
                          </tr>
                        </thead>
                        <tbody className="divide-y">
                          {selectedOrder.items.map((item, idx) => (
                            <tr key={`${selectedOrder.id}-${idx}`} className="hover:bg-gray-50">
                              <td className="p-3 font-semibold text-gray-900">{item.productName}</td>
                              <td className="p-3 text-gray-600">{item.productId}</td>
                              <td className="p-3 text-gray-600">{item.size}</td>
                              <td className="p-3 text-gray-600">{item.quantity}</td>
                              <td className="p-3 text-gray-600">${Number(item.price || 0).toFixed(2)}</td>
                            </tr>
                          ))}
                        </tbody>
                      </table>
                    </div>
                  </div>
                </div>

                <div className="space-y-4">
                  <div className="bg-black text-white p-4 rounded-2xl">
                    <p className="text-[9px] text-orange-500 font-black uppercase tracking-widest mb-1 italic">Settlement Total</p>
                    <p className="text-2xl font-black italic tracking-tighter text-white">${selectedOrder.total.toFixed(2)}</p>
                  </div>
                  <div className="flex flex-col gap-2">
                    <button
                      type="button"
                      disabled={normalizeOrderStatus(selectedOrder.status) !== 'pending' || dispatchingOrderIds.has(selectedOrder.id) || cancelingOrderIds.has(selectedOrder.id)}
                      onClick={async () => {
                        setOrdersActionError(null);
                        if (normalizeOrderStatus(selectedOrder.status) !== 'pending') return;
                        if (!beginOrderDispatch(selectedOrder.id)) return;

                        let dispatchSucceeded = false;
                        try {
                          await updateOrderStatus(selectedOrder.id, 'dispatched');
                          dispatchSucceeded = true;

                          setOrders((prev) => prev.map((order) => (
                            order.id === selectedOrder.id ? { ...order, status: 'dispatched' } : order
                          )));

                          try {
                            const [refreshedOrders, refreshedProducts, refreshedMetrics, refreshedTotals] = await Promise.all([
                              getOrders(),
                              getProducts(),
                              recalculateFinancialMetrics(),
                              getFinancialDashboardTotals(),
                            ]);
                            setOrders(refreshedOrders);
                            setProducts(refreshedProducts);
                            setFinancialMetrics(refreshedMetrics);
                            setFinancialTotals(refreshedTotals);
                          } catch (refreshError) {
                            console.error('Dispatch succeeded but refresh failed:', refreshError);
                          }
                        } catch (error) {
                          console.error('Error updating order status:', error);
                          const message = error instanceof Error
                            ? error.message
                            : String((error as any)?.message || (error as any)?.details || (error as any)?.hint || 'Failed to dispatch order. Please try again.');
                          setOrdersActionError(message);
                          alert(message);
                        } finally {
                          endOrderDispatch(selectedOrder.id);
                          if (!dispatchSucceeded) {
                            // Nothing else required: pending orders become clickable again after lock is released.
                          }
                        }
                      }}
                      className={`w-full px-6 py-3 rounded-2xl text-[11px] font-black uppercase tracking-widest transition-all shadow-xl ${normalizeOrderStatus(selectedOrder.status) === 'pending' && !dispatchingOrderIds.has(selectedOrder.id) && !cancelingOrderIds.has(selectedOrder.id) ? 'bg-orange-600 text-white hover:bg-orange-700 shadow-orange-600/20' : 'bg-gray-200 text-gray-500 cursor-not-allowed shadow-transparent'}`}
                    >
                      {dispatchingOrderIds.has(selectedOrder.id)
                        ? 'Dispatching...'
                        : normalizeOrderStatus(selectedOrder.status) === 'dispatched'
                          ? 'Dispatched'
                          : 'Dispatch Order'}
                    </button>
                    <button
                      type="button"
                      disabled={normalizeOrderStatus(selectedOrder.status) === 'canceled' || cancelingOrderIds.has(selectedOrder.id) || dispatchingOrderIds.has(selectedOrder.id)}
                      onClick={async () => {
                        setOrdersActionError(null);
                        if (normalizeOrderStatus(selectedOrder.status) === 'canceled') return;
                        if (!beginOrderCancel(selectedOrder.id)) return;

                        try {
                          await updateOrderStatus(selectedOrder.id, 'canceled');
                          setOrders((prev) => prev.map((order) => (
                            order.id === selectedOrder.id ? { ...order, status: 'canceled' } : order
                          )));

                          try {
                            const [refreshedOrders, refreshedProducts, refreshedMetrics, refreshedTotals] = await Promise.all([
                              getOrders(),
                              getProducts(),
                              recalculateFinancialMetrics(),
                              getFinancialDashboardTotals(),
                            ]);
                            setOrders(refreshedOrders);
                            setProducts(refreshedProducts);
                            setFinancialMetrics(refreshedMetrics);
                            setFinancialTotals(refreshedTotals);
                          } catch (refreshError) {
                            console.error('Cancel succeeded but refresh failed:', refreshError);
                          }
                        } catch (error) {
                          console.error('Error canceling order:', error);
                          const message = error instanceof Error
                            ? error.message
                            : String((error as any)?.message || (error as any)?.details || (error as any)?.hint || 'Failed to cancel order. Please try again.');
                          setOrdersActionError(message);
                          alert(message);
                        } finally {
                          endOrderCancel(selectedOrder.id);
                        }
                      }}
                      className={`w-full px-6 py-3 rounded-2xl text-[11px] font-black uppercase tracking-widest transition-all shadow-xl border ${normalizeOrderStatus(selectedOrder.status) !== 'canceled' && !cancelingOrderIds.has(selectedOrder.id) && !dispatchingOrderIds.has(selectedOrder.id) ? 'bg-white text-red-600 border-red-200 hover:bg-red-50 shadow-red-600/10' : 'bg-gray-200 text-gray-500 cursor-not-allowed shadow-transparent border-transparent'}`}
                    >
                      {cancelingOrderIds.has(selectedOrder.id) ? 'Canceling...' : 'Cancel Order'}
                    </button>
                    <button
                      onClick={async () => {
                        if (confirm('Erase this distribution record?')) {
                          try {
                            await deleteOrder(selectedOrder.id);
                            const refreshedOrders = await getOrders();
                            setOrders(refreshedOrders);
                            setSelectedOrderId(null);
                          } catch (error) {
                            console.error('Error deleting order:', error);
                            setOrdersActionError('Failed to delete order. Please try again.');
                            alert('Failed to delete order. Please try again.');
                          }
                        }
                      }}
                      className="w-full py-2 text-gray-600 hover:text-red-500 text-[10px] font-black uppercase tracking-widest transition-all"
                    >
                      Destroy Log
                    </button>
                  </div>
                </div>
              </div>
            </div>
          ) : (
            <div className="bg-white border rounded-2xl overflow-hidden">
              <div className="p-4 border-b bg-gray-50 flex items-center justify-between">
                <div>
                  <p className="text-[10px] font-bold uppercase text-gray-500">Orders</p>
                  <h3 className="text-sm md:text-base font-black uppercase text-gray-900">All Orders</h3>
                </div>
                <span className="text-[10px] bg-gray-900 text-white px-3 py-1 rounded-full font-bold uppercase">{orders.length} Orders</span>
              </div>
              <div className="overflow-x-auto">
                <table className="w-full text-left text-[11px] min-w-[800px]">
                  <thead className="bg-gray-100 uppercase font-black text-gray-500 border-b">
                    <tr>
                      <th className="p-3">Order ID</th>
                      <th className="p-3">Customer</th>
                      <th className="p-3">Date</th>
                      <th className="p-3">Status</th>
                      <th className="p-3">Total</th>
                      <th className="p-3">Payment</th>
                    </tr>
                  </thead>
                  <tbody className="divide-y">
                    {orders.map((order) => {
                      const normalizedStatus = normalizeOrderStatus(order.status);
                      const statusClasses = normalizedStatus === 'pending'
                        ? 'bg-orange-100 text-orange-600'
                        : normalizedStatus === 'dispatched'
                          ? 'bg-blue-100 text-blue-600'
                          : normalizedStatus === 'canceled'
                            ? 'bg-red-100 text-red-700'
                            : 'bg-green-100 text-green-700';
                      return (
                        <tr
                          key={order.id}
                          onClick={() => setSelectedOrderId(order.id)}
                          className="hover:bg-gray-50 transition-colors cursor-pointer"
                        >
                          <td className="p-3 font-bold text-gray-700">{order.id}</td>
                          <td className="p-3 font-semibold text-gray-900">{order.customerName}</td>
                          <td className="p-3 text-gray-600">{new Date(order.date).toLocaleDateString()}</td>
                          <td className="p-3">
                            <span className={`px-2 py-1 rounded text-[10px] font-bold uppercase ${statusClasses}`}>
                              {normalizedStatus}
                            </span>
                          </td>
                          <td className="p-3 text-gray-700 font-bold">${order.total.toFixed(2)}</td>
                          <td className="p-3 text-gray-600">{getOrderPaymentStatus(order)}</td>
                        </tr>
                      );
                    })}
                  </tbody>
                </table>
              </div>
            </div>
          )}
        </div>
      )}

      {activeTab === 'theme' && <EditThemePanel />}

      {activeTab === 'tags' && <TagsManagerPanel />}

        </div>
      </div>

    </div>
  );
}

function CheckoutView({ cart, setCart, setCartNotice, setOrders, setProducts, setView, syncOrderToDatabase }: CheckoutViewProps) {
  const cartTotal = cart.reduce((acc, item) => acc + item.price * item.quantity, 0);
  const checkoutTotal = cart.length > 0 ? cartTotal + DELIVERY_FEE : 0;
  const [gov, setGov] = useState('');
  const [dist, setDist] = useState('');
  const [vill, setVill] = useState('');
  const [isProcessing, setIsProcessing] = useState(false);

  const handleSubmit = async (e: React.FormEvent<HTMLFormElement>) => {
    e.preventDefault();
    setIsProcessing(true);
    const form = e.currentTarget;
    const fd = new FormData(form);

    const checkoutItems = [...cart];

    if (checkoutItems.length === 0) {
      setIsProcessing(false);
      alert('Your cart is empty.');
      return;
    }

    for (const item of checkoutItems) {
      if (!item.reservationId) {
        setCart(prev => prev.filter((it) => !(it.Product_ID === item.Product_ID && it.selectedSize === item.selectedSize)));
        setCartNotice('Some items in your cart have expired.');
        alert('Some items in your cart have expired');
        setIsProcessing(false);
        return;
      }

      const extension = await extendExpiredReservation(item.reservationId, undefined, 180);
      if (!extension.ok || !extension.expiresAt) {
        await releaseCartLineReservation(item.reservationId);
        setCart(prev => prev.filter((it) => !(it.Product_ID === item.Product_ID && it.selectedSize === item.selectedSize)));
        setCartNotice('Some items in your cart have expired.');
        alert('Some items in your cart have expired');
        setIsProcessing(false);
        return;
      }

      item.expiresAt = extension.expiresAt;
    }

    setCart((prev) => prev.map((item) => {
      const refreshed = checkoutItems.find((line) => line.Product_ID === item.Product_ID && line.selectedSize === item.selectedSize);
      return refreshed ? { ...item, expiresAt: refreshed.expiresAt } : item;
    }));

    const orderId = await generateOrderId();

    const order: Order = {
      id: orderId,
      customerName: fd.get('name') as string,
      customerEmail: fd.get('email') as string,
      customerPhone: fd.get('phone') as string,
      governorate: gov,
      district: dist,
      village: vill,
      addressDetails: fd.get('address') as string,
      items: checkoutItems.map(i => ({ productId: i.Product_ID, productName: i.productName || i.name, quantity: i.quantity, size: i.selectedSize, price: i.price, reservationId: i.reservationId })),
      total: checkoutTotal,
      status: 'pending',
      date: new Date().toISOString()
    };
    
    try {
      await syncOrderToDatabase(order);
      const [refreshedOrders, refreshedProducts] = await Promise.all([
        getOrders(),
        getProducts()
      ]);
      setOrders(refreshedOrders);
      setProducts(refreshedProducts);
      setCart([]);
      
      setTimeout(() => {
        setIsProcessing(false);
        setView('home');
        alert('SUCCESS: Your authentic gear has been secured. Our team will contact you shortly.');
      }, 1200);
    } catch (error) {
      console.error('Error processing order:', error);
      setIsProcessing(false);
      const message = error instanceof Error ? error.message : 'Failed to process order. Please check your connection and try again.';
      alert(message);
    }
  };

  return (
      <div className="max-w-3xl mx-auto px-4 py-8 animate-fade-in-up">
      <div className="text-center mb-8">
        <h2 className="text-xl md:text-2xl font-black italic tracking-tighter uppercase mb-2">Complete Acquisition</h2>
        <p className="text-gray-400 font-bold uppercase text-[9px] tracking-[0.2em]">Direct-to-door Logistics Across Lebanon</p>
      </div>
      <form onSubmit={handleSubmit} className="bg-white p-6 rounded-3xl border shadow-2xl space-y-6 border-gray-100">
        <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
           <div className="space-y-2">
              <label className="text-[9px] font-black text-gray-400 uppercase tracking-widest ml-1">Recipient Name</label>
              <input name="name" required placeholder="Full Name" className="w-full p-3 bg-gray-50 border rounded-2xl focus:ring-2 focus:ring-orange-500 transition-all font-bold text-sm outline-none" />
           </div>
           <div className="space-y-2">
              <label className="text-[9px] font-black text-gray-400 uppercase tracking-widest ml-1">Contact Number</label>
              <input name="phone" required placeholder="+961" className="w-full p-3 bg-gray-50 border rounded-2xl focus:ring-2 focus:ring-orange-500 transition-all font-bold text-sm outline-none" />
           </div>
        </div>
        <div className="space-y-2">
           <label className="text-[9px] font-black text-gray-400 uppercase tracking-widest ml-1">Email for Confirmation</label>
           <input name="email" type="email" required placeholder="email@address.com" className="w-full p-3 bg-gray-50 border rounded-2xl focus:ring-2 focus:ring-orange-500 transition-all font-bold text-sm outline-none" />
        </div>
        
        <div className="space-y-4 p-4 bg-gray-50 rounded-2xl border border-gray-100">
           <h4 className="font-black text-[10px] uppercase tracking-widest flex items-center gap-2 text-black italic">
             <Truck size={16} className="text-orange-600" /> Logistics Destination
           </h4>
           <div className="grid grid-cols-1 md:grid-cols-3 gap-2">
             <select required value={gov} onChange={e => {setGov(e.target.value); setDist(''); setVill('');}} className="p-3 border rounded-xl bg-white text-[10px] font-black uppercase focus:ring-2 focus:ring-orange-500 transition-all outline-none">
               <option value="">Governorate</option>
               {Object.keys(LEBANON_LOCATIONS).map(g => <option key={g} value={g}>{g}</option>)}
             </select>
             <select required disabled={!gov} value={dist} onChange={e => {setDist(e.target.value); setVill('');}} className="p-3 border rounded-xl bg-white text-[10px] font-black uppercase disabled:opacity-50 focus:ring-2 focus:ring-orange-500 transition-all outline-none">
               <option value="">District</option>
               {gov && Object.keys(LEBANON_LOCATIONS[gov]).map(d => <option key={d} value={d}>{d}</option>)}
             </select>
             <select required disabled={!dist} value={vill} onChange={e => setVill(e.target.value)} className="p-3 border rounded-xl bg-white text-[10px] font-black uppercase disabled:opacity-50 focus:ring-2 focus:ring-orange-500 transition-all outline-none">
               <option value="">Village</option>
               {gov && dist && LEBANON_LOCATIONS[gov][dist].map(v => <option key={v} value={v}>{v}</option>)}
             </select>
           </div>
           <textarea name="address" required placeholder="Street, Building, Floor... Provide landmarks for faster delivery." className="w-full p-4 bg-white border rounded-xl text-sm font-bold focus:ring-2 focus:ring-orange-500 transition-all outline-none" rows={3}></textarea>
        </div>

        <div className="pt-6 border-t border-dashed">
          <div className="space-y-1">
            <div className="flex justify-between text-[11px] font-bold text-gray-500 uppercase tracking-widest">
              <span>Items Total</span>
              <span>${cartTotal.toFixed(2)}</span>
            </div>
            <div className="flex justify-between text-[11px] font-bold text-gray-500 uppercase tracking-widest">
              <span>Delivery</span>
              <span>${DELIVERY_FEE.toFixed(2)}</span>
            </div>
            <div className="flex justify-between pt-2 border-t border-gray-200">
              <p className="text-[10px] text-gray-400 font-black uppercase tracking-widest">Grand Total</p>
              <p className="text-2xl font-black text-black italic tracking-tighter">${checkoutTotal.toFixed(2)}</p>
            </div>
          </div>
        </div>

        <button type="submit" disabled={isProcessing} className="w-full bg-orange-600 text-white font-black py-2.5 rounded-xl hover:bg-orange-700 shadow-2xl shadow-orange-600/30 transition-all uppercase tracking-widest text-sm md:text-base flex items-center justify-center gap-2 active:scale-95 disabled:opacity-70">
          {isProcessing ? 'Verifying Acquisition...' : 'Place Secure Order'}
        </button>
      </form>
    </div>
  );
}

function CartView({ cart, setView, cartNotice, removeFromCart, getRemainingMs, formatRemaining }: CartViewProps) {
  const cartTotal = cart.reduce((acc, item) => acc + item.price * item.quantity, 0);
  const checkoutTotal = cart.length > 0 ? cartTotal + DELIVERY_FEE : 0;
  const [nowMs, setNowMs] = useState<number>(Date.now());

  useEffect(() => {
    if (cart.length === 0) return;
    const interval = window.setInterval(() => {
      setNowMs(Date.now());
    }, 1000);
    return () => window.clearInterval(interval);
  }, [cart.length]);

  return (
  <div className="max-w-6xl mx-auto px-4 py-10 animate-fade-in-up">
    <h2 className="text-2xl font-black mb-8 uppercase italic tracking-tighter text-center md:text-left">Selected Gear</h2>
    {cartNotice && (
      <div className="mb-4 rounded-xl border border-orange-200 bg-orange-50 text-orange-700 px-4 py-3 text-xs font-black uppercase tracking-wider">
        {cartNotice}
      </div>
    )}
    {cart.length === 0 ? (
      <div className="text-center py-20 bg-white rounded-3xl border-2 border-dashed border-gray-100 shadow-inner">
        <ShoppingBag size={60} className="text-gray-100 mx-auto mb-6" />
        <p className="text-gray-300 font-black uppercase tracking-[0.3em] text-xs mb-8 italic">Your distribution bag is currently empty</p>
        <button onClick={() => setView('shop')} className="bg-black text-white px-6 py-2.5 rounded-full font-black uppercase tracking-[0.2em] hover:bg-orange-600 transition-all shadow-2xl italic text-sm">Explore Collections</button>
      </div>
    ) : (
      <div className="grid grid-cols-1 lg:grid-cols-3 gap-10 lg:gap-12">
        <div className="lg:col-span-2 space-y-8">
          {cart.map((it, idx) => (
             <div key={idx} className="flex flex-col sm:flex-row gap-8 p-8 bg-white rounded-[4rem] border shadow-sm hover:shadow-2xl transition-all group border-gray-50">
                <div className="w-full sm:w-48 h-64 bg-white rounded-[2.5rem] overflow-hidden shadow-inner flex-shrink-0">
                  <SafeImage src={it.image} className="w-full h-full object-contain p-2 transition-transform duration-700 group-hover:scale-[1.03]" alt={it.name} />
                </div>
               <div className="flex-1 flex flex-col justify-between py-4">
                 <div className="flex justify-between items-start">
                   <div>
                     <h4 className="font-black text-2xl uppercase italic tracking-tighter mb-2 text-black">{it.productName || it.name}</h4>
                     <div className="flex items-center gap-2 mb-4">
                       <span className="text-[10px] font-black uppercase text-orange-600 tracking-widest px-3 py-1 bg-orange-50 rounded-full">{it.type}</span>
                       <span className="text-[10px] font-black uppercase text-gray-400 tracking-widest px-3 py-1 bg-gray-50 rounded-full border border-gray-100">{it.category}</span>
                     </div>
                   </div>
                  <button onClick={() => void removeFromCart(it.Product_ID, it.selectedSize)} className="p-3 bg-gray-50 text-gray-200 hover:text-red-500 hover:bg-red-50 rounded-2xl transition-all">
                      <Trash2 size={24} />
                   </button>
                 </div>
                 <div className="flex flex-wrap items-center gap-4">
                    <span className="text-[10px] font-black bg-black text-white px-5 py-2 rounded-2xl uppercase tracking-widest italic border border-black shadow-lg">Size: {it.selectedSize}</span>
                    <span className="text-[10px] font-black bg-white text-gray-900 px-5 py-2 rounded-2xl uppercase tracking-widest italic border-2 border-gray-100">Qty: {it.quantity}</span>
                   <span className={`text-[10px] font-black px-5 py-2 rounded-2xl uppercase tracking-widest italic border-2 ${getRemainingMs(it, nowMs) > 0 ? 'bg-emerald-50 text-emerald-700 border-emerald-200' : 'bg-red-50 text-red-700 border-red-200'}`}>
                    {getRemainingMs(it, nowMs) > 0 ? `${formatRemaining(getRemainingMs(it, nowMs))} remaining` : 'Expired'}
                   </span>
                 </div>
                 <div className="flex justify-end pt-6 border-t border-gray-50 mt-8">
                   <span className="font-black text-4xl text-black italic tracking-tighter">${(it.price * it.quantity).toFixed(2)}</span>
                 </div>
               </div>
             </div>
          ))}
        </div>
        <div className="bg-black text-white p-8 rounded-3xl shadow-3xl h-fit sticky top-24 border-4 border-white/5 overflow-hidden">
          <div className="absolute top-0 right-0 w-40 h-40 bg-orange-600/10 rounded-full -translate-y-20 translate-x-20 blur-3xl"></div>
          <h3 className="font-black mb-10 uppercase tracking-[0.4em] text-[11px] text-orange-500 italic relative">Acquisition Totals</h3>
          <div className="space-y-6 mb-12 relative">
             <div className="flex justify-between font-bold text-gray-400 uppercase text-[11px] tracking-widest">
               <span>Retail Value</span>
               <span className="text-white">${cartTotal.toFixed(2)}</span>
             </div>
             <div className="flex justify-between font-bold text-gray-400 uppercase text-[11px] tracking-widest">
               <span>Delivery</span>
               <span className="text-white">${DELIVERY_FEE.toFixed(2)}</span>
             </div>
             <div className="pt-10 border-t border-white/10 flex justify-between items-end">
               <div>
                 <span className="text-[10px] text-gray-500 font-black uppercase block mb-2 italic">Grand Total Acquisition</span>
                 <span className="text-5xl font-black italic tracking-tighter text-orange-600">${checkoutTotal.toFixed(2)}</span>
               </div>
             </div>
          </div>
          <button onClick={() => setView('checkout')} className="w-full bg-white text-black font-black py-3.5 rounded-2xl uppercase tracking-widest hover:bg-orange-600 hover:text-white transition-all shadow-2xl text-sm md:text-base italic active:scale-95">
            Secure Checkout
          </button>
          <div className="mt-12 space-y-4 relative">
            <div className="flex items-center gap-3 text-[10px] text-gray-500 font-black uppercase tracking-[0.3em]"><Check size={16} className="text-orange-500" /> Authenticity Verified</div>
            <div className="flex items-center gap-3 text-[10px] text-gray-500 font-black uppercase tracking-[0.3em]"><Check size={16} className="text-orange-500" /> Cash Payment Accepted</div>
          </div>
        </div>
      </div>
    )}
  </div>
  );
}
export default App;
