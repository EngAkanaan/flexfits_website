
import React, { useState, useEffect, useMemo, useRef, useCallback, useDeferredValue } from 'react';
import { ShoppingBag, User, Search, Filter, Trash2, Plus, LogOut, ChevronRight, CheckCircle, Package, BarChart3, Menu, X, Star, ExternalLink, Edit2, Upload, Phone, MapPin, Truck, Check, Mail, List, Layers, Info } from 'lucide-react';
import { Category, Product, ProductGender, ProductSizeStock, Order, CartItem, FinancialMetric, FinancialTotals, View } from './types';
import { INITIAL_PRODUCTS, ADMIN_USER, ADMIN_PASS, LEBANON_LOCATIONS, SIZE_OPTIONS } from './constants';
import { getProductRecommendation } from './services/gemini';
import { getProducts, saveProduct, deleteProduct, getOrders, saveOrder, updateOrderStatus, deleteOrder, recalculateFinancialMetrics, getFinancialDashboardTotals, reserveCartLine, releaseCartLineReservation, cleanupExpiredReservations, extendExpiredReservation, getProductColorTokens, uploadProductImagesToStorage } from './services/database';

const BRAND_LOGO_SRC = '/flex-logo.JPG';
const DELIVERY_FEE = 4;
const GENDER_OPTIONS: ProductGender[] = ['Men', 'Women', 'Unisex'];
const NUMERIC_SIZE_FILTER_OPTIONS = Array.from({ length: 16 }, (_, i) => String(35 + i));
const CLOTHING_SIZE_FILTER_OPTIONS = ['S', 'M', 'L', 'XL'];
const CART_STORAGE_KEY = 'flex_cart';

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
  const lower = normalized.toLowerCase();
  if (lower.startsWith('/product/')) {
    const productId = decodeURIComponent(normalized.slice('/product/'.length)).trim();
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
        stock: Math.max(0, Math.floor(Number(entry?.stock || 0))),
      }))
      .filter((entry) => entry.size);
  }

  const fallbackPieces = Math.max(0, Math.floor(Number(product.pieces || 0)));
  return (product.sizes || []).map((size) => ({ size, stock: fallbackPieces }));
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
  if (/^\/[\w./%+-]+$/i.test(value)) return true;
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

  const isOutOfStock = getTotalStock(product) <= 0 || product.status === 'Temporary Not Available' || product.status === 'Temporarily unavailable' || product.status === 'Out of Stock';
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
        {isOutOfStock && (
          <div className="absolute bottom-2 right-2 bg-red-600 text-white text-[8px] font-black uppercase tracking-[0.12em] px-2 py-1 rounded-full shadow-lg">
            Sold Out
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
          <span className={`text-[11px] font-black ${getTotalStock(product) <= 0 ? 'text-red-500' : getTotalStock(product) < 10 ? 'text-orange-500' : 'text-green-600'}`}>
            {isOutOfStock ? 'Sold Out' : `${getTotalStock(product)} left`}
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
                  <span className="text-[8px] normal-case tracking-normal">{sizeStock > 0 ? sizeStock : '0'}</span>
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
    return product.sizeStock.reduce((total, entry) => total + Math.max(0, Math.floor(Number(entry.stock || 0))), 0);
  }
  return Math.max(0, Math.floor(Number(product.pieces || 0)));
}

function getSizeStock(product: Product, size: string): number {
  const normalizedSize = String(size || '').trim();
  const sizeEntries = normalizeSizeStockEntries(product);
  const match = sizeEntries.find((entry) => String(entry.size || '').trim() === normalizedSize);
  if (match) return Math.max(0, Math.floor(Number(match.stock || 0)));
  return Math.max(0, Math.floor(Number(product.pieces || 0)));
}

function buildEditableSizeStock(product: Product): ProductSizeStock[] {
  if (Array.isArray(product.sizeStock) && product.sizeStock.length > 0) {
    return product.sizeStock.map((entry) => ({
      size: String(entry.size || '').trim(),
      stock: Math.max(0, Math.floor(Number(entry.stock || 0))),
    })).filter((entry) => entry.size);
  }

  const sizes = Array.isArray(product.sizes) ? product.sizes.filter((size) => String(size || '').trim()) : [];
  const totalStock = Math.max(0, Math.floor(Number(product.initialStock || product.pieces || 0)));
  if (sizes.length === 0) return [];

  return sizes.map((size, index) => ({
    size,
    stock: Math.max(0, Math.floor(totalStock / sizes.length) + (index < (totalStock % sizes.length) ? 1 : 0)),
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
  const [isAdmin, setIsAdmin] = useState(false);
  const [searchQuery, setSearchQuery] = useState('');
  const deferredSearchQuery = useDeferredValue(searchQuery);
  const [filterCategory, setFilterCategory] = useState<Category | 'All'>('All');
  const [maxPrice, setMaxPrice] = useState<number>(150);
  const [selectedSizeFilters, setSelectedSizeFilters] = useState<string[]>([]);
  const [selectedColorFilters, setSelectedColorFilters] = useState<string[]>([]);
  const [selectedBrands, setSelectedBrands] = useState<string[]>([]);
  const [hideSoldOutItems, setHideSoldOutItems] = useState<boolean>(false);
  const [selectedGenders, setSelectedGenders] = useState<ProductGender[]>([]);
  const [isCategoryFilterExpanded, setIsCategoryFilterExpanded] = useState<boolean>(true);
  const [isColorFilterExpanded, setIsColorFilterExpanded] = useState<boolean>(true);
  const [isSizeFilterExpanded, setIsSizeFilterExpanded] = useState<boolean>(false);
  const [isGenderFilterExpanded, setIsGenderFilterExpanded] = useState<boolean>(false);
  const [isBrandFilterExpanded, setIsBrandFilterExpanded] = useState<boolean>(false);
  const [isMobileFilterOpen, setIsMobileFilterOpen] = useState<boolean>(false);
  const [cartNotice, setCartNotice] = useState<string>('');
  const [imageViewerProduct, setImageViewerProduct] = useState<Product | null>(null);
  const [imageViewerScale, setImageViewerScale] = useState<number>(1);
  const [imageViewerTranslate, setImageViewerTranslate] = useState<{ x: number; y: number }>({ x: 0, y: 0 });
  const preloadedImageUrlsRef = useRef<Set<string>>(new Set());
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
    try {
      localStorage.setItem(CART_STORAGE_KEY, JSON.stringify(cart));
    } catch {
      // Ignore storage issues to avoid interrupting cart flow.
    }
  }, [cart]);

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
      const leftStock = getTotalSizeStock(p);
      const normalizedStatus = String((p as any).Status ?? p.status ?? '').trim().toLowerCase();
      const isSoldOut = leftStock <= 0 || normalizedStatus === 'out of stock';
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
      return matchesSearch && matchesColors && matchesCategory && matchesPrice && matchesSize && matchesGender && matchesBrand && !(hideSoldOutItems && isSoldOut);
    });
  }, [products, deferredSearchQuery, filterCategory, maxPrice, selectedSizeFilters, selectedGenders, selectedColorFilters, selectedBrands, hideSoldOutItems]);

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
    if (!liveProduct || liveProduct.pieces <= 0) {
      alert("This item is currently out of stock!");
      return false;
    }

    const liveSizeStock = getSizeStock(liveProduct, size);
    if (liveSizeStock <= 0) {
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
      alert(reservation.message || "Sorry, this item is currently reserved by another shopper.");
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
        ? currentSizeStock.map((entry) => entry.size === size ? { ...entry, stock: Math.max(0, entry.stock - requestedQty) } : entry)
        : currentSizeStock;
      if (reservation.availableAfter !== undefined) {
        return { ...p, pieces: Math.max(0, Number(reservation.availableAfter || 0)), sizeStock: nextSizeStock.length > 0 ? nextSizeStock : p.sizeStock };
      }
      return { ...p, pieces: Math.max(0, Number(p.pieces || 0) - requestedQty), sizeStock: nextSizeStock.length > 0 ? nextSizeStock : p.sizeStock };
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

  const openImageViewer = (product: Product) => {
    setImageViewerProduct(product);
    setImageViewerScale(1);
    setImageViewerTranslate({ x: 0, y: 0 });
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
              ? { ...entry, stock: Math.max(0, entry.stock + releasedQty) }
              : entry
          ))
        : product.sizeStock;

      return {
        ...product,
        pieces: Math.max(0, Number(product.pieces || 0) + releasedQty),
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
      <div className="pt-4 border-t-2 border-gray-50">
        <label className="flex items-center gap-2.5 p-2.5 border rounded-xl bg-white text-[9px] font-black uppercase tracking-wider cursor-pointer">
          <input
            type="checkbox"
            checked={hideSoldOutItems}
            onChange={(e) => setHideSoldOutItems(e.target.checked)}
            className="h-3.5 w-3.5 accent-orange-600"
          />
          <span>Hide Sold Out Items</span>
        </label>
      </div>
    </>
  );

  const AdminPanel = () => {
    type InventorySection = 'All' | Category | 'ComingSoon';
    const [user, setUser] = useState('');
    const [pass, setPass] = useState('');
    const [activeTab, setActiveTab] = useState<'orders' | 'add' | 'inventory' | 'financials'>('inventory');
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
    const [inventorySection, setInventorySection] = useState<InventorySection>('All');
    const [inventorySort, setInventorySort] = useState<{ col: 'id' | 'productName' | 'category'; dir: 'asc' | 'desc' } | null>(null);
    const [financialMetrics, setFinancialMetrics] = useState<FinancialMetric[]>([]);
    const [financialTotals, setFinancialTotals] = useState<FinancialTotals | null>(null);
    const [inventoryPage, setInventoryPage] = useState(1);
    const inventoryPageSize = 20;
    const fileRef = useRef<HTMLInputElement>(null);
    const isShoesCategory = formCategory === Category.SHOES;

    const cycleSort = (col: 'Product_ID' | 'productName' | 'category') => {
      setInventorySort(prev =>
        prev?.col !== col ? { col, dir: 'asc' }
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
      }
    }, [editMode]);

    useEffect(() => {
      setFormSizeStock((prev) => {
        const next = selectedSizes.map((size) => {
          const existing = prev.find((entry) => entry.size === size);
          return existing || { size, stock: 0 };
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
    }, [isAdmin, orders.length]);

    useEffect(() => {
      return () => {
        for (const preview of uploadedImagePreviews) {
          if (preview.startsWith('blob:')) {
            URL.revokeObjectURL(preview);
          }
        }
      };
    }, [uploadedImagePreviews]);

    const fallbackRevenue = financialMetrics.reduce((acc, row) => acc + row.revenue, 0);
    const fallbackProfit = financialMetrics.reduce((acc, row) => acc + row.netProfit, 0);
    const totalSalesValue = financialTotals?.totalRevenue ?? fallbackRevenue;
    const profit = financialTotals?.totalNetProfit ?? fallbackProfit;

    const inventorySections: InventorySection[] = ['All', ...Object.values(Category), 'ComingSoon'];
    const inventoryProducts = useMemo(() => {
      let list = inventorySection === 'All' ? products
        : inventorySection === 'ComingSoon' ? products.filter(p => /t-?shirt|hoodie/i.test(p.type))
        : products.filter(p => p.category === inventorySection);
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
    }, [products, inventorySection, inventorySort]);

    useEffect(() => {
      setInventoryPage(1);
    }, [inventorySection, inventorySort, products.length]);

    const inventoryTotalPages = Math.max(1, Math.ceil(inventoryProducts.length / inventoryPageSize));
    const pagedInventoryProducts = useMemo(() => {
      const start = (inventoryPage - 1) * inventoryPageSize;
      return inventoryProducts.slice(start, start + inventoryPageSize);
    }, [inventoryProducts, inventoryPage, inventoryPageSize]);

    if (!isAdmin) {
      return (
        <div className="min-h-[60vh] flex items-center justify-center p-4">
          <div className="bg-white p-8 rounded-3xl shadow-xl w-full max-w-md border">
            <h2 className="text-xl font-black mb-6 text-center uppercase tracking-widest">Admin Authorization</h2>
            <input type="text" placeholder="Admin Username" className="w-full mb-4 p-3 bg-gray-50 rounded-xl border focus:ring-2 focus:ring-orange-500 transition-all outline-none" value={user} onChange={e => setUser(e.target.value)} />
            <input type="password" placeholder="Password" className="w-full mb-6 p-3 bg-gray-50 rounded-xl border focus:ring-2 focus:ring-orange-500 transition-all outline-none" value={pass} onChange={e => setPass(e.target.value)} />
            <button onClick={() => { if (user === ADMIN_USER && pass === ADMIN_PASS) setIsAdmin(true); else alert('Access Denied: Incorrect Credentials'); }} className="w-full bg-black text-white py-4 rounded-xl font-bold hover:bg-orange-600 transition-all uppercase tracking-widest">Login</button>
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

        if (/^\/[\w./%+-]+$/i.test(candidate)) {
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
        return {
          size,
          stock: Math.max(0, Math.floor(Number(existing?.stock ?? 0))),
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
        : selectedSizes.map((size, index) => ({
            size,
            stock: Math.max(0, Math.floor(resolvedStock / selectedSizes.length) + (index < (resolvedStock % selectedSizes.length) ? 1 : 0)),
          }));

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
        formEl.reset();
      } catch (error: any) {
        console.error('Error saving product:', error);
        const msg = error?.message || error?.error_description || JSON.stringify(error);
        alert(`Failed to save product to database.\n\nError: ${msg}\n\nCheck Supabase dashboard → Table Editor → products → RLS policies.`);
      }
    };

    return (
      <div className="max-w-7xl mx-auto px-4 py-10">
        <div className="flex flex-col md:flex-row justify-between items-start md:items-center mb-6 bg-white border p-4 rounded-xl gap-3">
          <div>
            <p className="text-[10px] font-bold uppercase text-gray-500 mb-1">Admin Dashboard</p>
            <h2 className="text-lg md:text-xl font-black uppercase text-gray-900">Inventory Control</h2>
          </div>
          <div className="flex flex-wrap gap-2">
            <button onClick={() => setActiveTab('inventory')} className={`px-4 py-2 rounded-lg font-bold uppercase text-xs transition-colors flex items-center gap-2 border ${activeTab === 'inventory' ? 'bg-gray-900 text-white border-gray-900' : 'bg-white text-gray-700 border-gray-200 hover:bg-gray-50'}`}><Layers size={14} /> Inventory</button>
            <button onClick={() => setActiveTab('add')} className={`px-4 py-2 rounded-lg font-bold uppercase text-xs transition-colors flex items-center gap-2 border ${activeTab === 'add' ? 'bg-gray-900 text-white border-gray-900' : 'bg-white text-gray-700 border-gray-200 hover:bg-gray-50'}`}><Plus size={14} /> Add / Edit</button>
            <button onClick={() => setActiveTab('orders')} className={`px-4 py-2 rounded-lg font-bold uppercase text-xs transition-colors flex items-center gap-2 border ${activeTab === 'orders' ? 'bg-gray-900 text-white border-gray-900' : 'bg-white text-gray-700 border-gray-200 hover:bg-gray-50'}`}><Package size={14} /> Orders</button>
            <button onClick={() => setActiveTab('financials')} className={`px-4 py-2 rounded-lg font-bold uppercase text-xs transition-colors flex items-center gap-2 border ${activeTab === 'financials' ? 'bg-gray-900 text-white border-gray-900' : 'bg-white text-gray-700 border-gray-200 hover:bg-gray-50'}`}><BarChart3 size={14} /> Financials</button>
            <button onClick={() => setIsAdmin(false)} className="bg-white hover:bg-red-50 text-gray-700 hover:text-red-600 px-3 py-2 rounded-lg transition-colors font-bold flex items-center gap-2 border border-gray-200"><LogOut size={14} /></button>
          </div>
        </div>

        <div className="grid grid-cols-1 md:grid-cols-3 gap-4 mb-8">
           <div className="bg-white p-4 rounded-xl border">
             <div className="flex justify-between items-center mb-1">
               <BarChart3 className="text-gray-500" size={18} />
               <span className="text-[10px] font-bold uppercase text-gray-500">Total Revenue</span>
             </div>
             <p className="text-lg md:text-xl font-black">${totalSalesValue.toLocaleString()}</p>
           </div>
           <div className="bg-white p-4 rounded-xl border">
             <div className="flex justify-between items-center mb-1">
               <Package className="text-gray-500" size={18} />
               <span className="text-[10px] font-bold uppercase text-gray-500">Orders Fulfilled</span>
             </div>
             <p className="text-lg md:text-xl font-black">{orders.length}</p>
           </div>
           <div className="bg-white p-4 rounded-xl border">
             <div className="flex justify-between items-center mb-1">
               <Star className="text-gray-500" size={18} />
               <span className="text-[10px] font-bold uppercase text-gray-500">Net Profit</span>
             </div>
             <p className="text-lg md:text-xl font-black text-gray-900">${profit.toLocaleString()}</p>
           </div>
        </div>

        {activeTab === 'financials' && (
          <div className="bg-white border rounded-xl overflow-hidden mb-8">
            <div className="p-4 border-b bg-gray-50 flex items-center justify-between gap-3">
              <div>
                <p className="text-[10px] font-bold uppercase text-gray-500">Financial Breakdown (Database)</p>
                <h3 className="text-sm md:text-base font-black uppercase text-gray-900">Revenue & Net Profit Per Product</h3>
              </div>
              <span className="text-[10px] bg-gray-900 text-white px-3 py-1 rounded-full font-bold uppercase">{financialMetrics.length} Items</span>
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
                  {financialMetrics.map((row) => (
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
                  {financialMetrics.length === 0 && (
                    <tr>
                      <td colSpan={7} className="p-6 text-center text-gray-500">No financial data yet — run the SQL in Supabase to backfill.</td>
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
          <div className="bg-white rounded-xl border overflow-hidden animate-fade-in-up">
            <div className="p-4 border-b bg-gray-50 flex flex-col gap-3">
              <div className="flex justify-between items-center">
                <div>
                  <h3 className="font-black uppercase text-sm text-gray-700">Inventory</h3>
                  <p className="text-[10px] text-gray-500 font-semibold uppercase">All sections connected to database</p>
                </div>
                <span className="text-[10px] bg-gray-900 text-white px-3 py-1 rounded-full font-bold uppercase">{inventoryProducts.length} Total</span>
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
            </div>
            <div className="overflow-x-auto">
              <table className="w-full text-left text-[11px] min-w-[1700px]">
                <thead className="bg-gray-100 uppercase font-black text-gray-500 border-b">
                  <tr>
                    <th className="p-3">
                      <button onClick={() => cycleSort('Product_ID')} className="flex items-center gap-1 hover:text-gray-900 transition-colors">
                        Product_ID
                        <span className="text-[10px] leading-none">{inventorySort?.col === 'Product_ID' ? (inventorySort.dir === 'asc' ? '▲' : '▼') : '⇅'}</span>
                      </button>
                    </th>
                    <th className="p-3">Name_of_Brand</th>
                    <th className="p-3">
                      <button onClick={() => cycleSort('productName')} className="flex items-center gap-1 hover:text-gray-900 transition-colors">
                        Name_of_Product
                        <span className="text-[10px] leading-none">{inventorySort?.col === 'productName' ? (inventorySort.dir === 'asc' ? '▲' : '▼') : '⇅'}</span>
                      </button>
                    </th>
                    <th className="p-3">
                      <button onClick={() => cycleSort('category')} className="flex items-center gap-1 hover:text-gray-900 transition-colors">
                        Category
                        <span className="text-[10px] leading-none">{inventorySort?.col === 'category' ? (inventorySort.dir === 'asc' ? '▲' : '▼') : '⇅'}</span>
                      </button>
                    </th>
                    <th className="p-3">Gender</th>
                    <th className="p-4">Type</th>
                    <th className="p-3">SIZE</th>
                    <th className="p-3">Colors</th>
                    <th className="p-3">Cost</th>
                    <th className="p-3">Price</th>
                    <th className="p-3">Stock</th>
                    <th className="p-3">Items left (set)</th>
                    <th className="p-3">Items_Sold</th>
                    <th className="p-3">Status</th>
                    <th className="p-3">Pictures</th>
                    <th className="p-3">Description</th>
                    <th className="p-3 text-right">Actions</th>
                  </tr>
                </thead>
                <tbody className="divide-y">
                  {pagedInventoryProducts.map(p => {
                    const stockStatus = p.pieces <= 0 ? 'Out of Stock' : p.pieces < 10 ? 'Low Stock' : 'Healthy';
                    const normalizedStatus = (p.status === 'Temporary Not Available' || p.status === 'Temporarily unavailable') ? 'Out of Stock' : (p.status || stockStatus);
                    const rowColors = getProductColorTokens(p);
                    return (
                      <tr key={p.Product_ID} className="hover:bg-gray-50 transition-colors">
                        <td className="p-3 font-bold text-gray-700">{p.Product_ID}</td>
                        <td className="p-3 font-semibold text-gray-900">{p.brandName || splitDisplayName(p.name).brand || '-'}</td>
                        <td className="p-3 font-semibold text-gray-900">{p.productName || splitDisplayName(p.name).product || '-'}</td>
                        <td className="p-3 text-gray-700">{p.category}</td>
                        <td className="p-3 text-gray-700">{normalizeGender(p.gender)}</td>
                        <td className="p-3 text-gray-700">{p.type}</td>
                        <td className="p-3 text-gray-700">{p.sizes.join(', ') || '-'}</td>
                        <td className="p-3">
                          <div className="flex flex-wrap gap-1 max-w-[140px]">
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
                        <td className="p-3 text-gray-700">${p.cost}</td>
                        <td className="p-3 font-bold text-gray-900">${p.price}</td>
                        <td className="p-3 text-gray-700">{p.initialStock}</td>
                        <td className="p-3 font-bold text-orange-600">
                          {p.pieces}
                        </td>
                        <td className="p-3 text-blue-600 font-bold">{p.sold}</td>
                        <td className="p-3">
                          <span className={`px-2 py-1 rounded text-[10px] font-bold uppercase ${normalizedStatus === 'Out of Stock' ? 'bg-red-50 text-red-700' : 'bg-blue-50 text-blue-700'}`}>
                            {normalizedStatus}
                          </span>
                        </td>
                        <td className="p-3">
                          <div className="flex items-center gap-2">
                            <div className="w-9 h-9 rounded border overflow-hidden bg-gray-50">
                                <SafeImage src={p.image} className="w-full h-full object-cover" alt={p.name} />
                              </div>
                            <span className="text-[10px] text-gray-500 max-w-[180px] truncate">{p.image || '-'}</span>
                          </div>
                        </td>
                        <td className="p-3 max-w-[260px]">
                          <p className="text-[10px] text-gray-600 leading-relaxed line-clamp-3">{p.description || '-'}</p>
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
                      <td colSpan={17} className="p-6 text-center text-gray-500 font-semibold">
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
            {orders.length === 0 ? (
              <div className="text-center py-16 bg-white rounded-2xl border border-dashed text-gray-300 font-black uppercase italic tracking-[0.2em] text-sm">No Distribution Records Found</div>
            ) : orders.map(o => (
              <div key={o.id} className="p-4 border rounded-2xl bg-white hover:shadow-2xl transition-all flex flex-col md:flex-row justify-between gap-4 border-gray-100">
                <div className="flex-1">
                  <div className="flex items-center gap-4 mb-6">
                    <span className="font-black uppercase text-2xl tracking-tighter italic text-black">{o.customerName}</span>
                    <span className={`text-[9px] px-5 py-2 rounded-full font-black uppercase tracking-[0.2em] ${o.status === 'pending' ? 'bg-orange-100 text-orange-600' : o.status === 'shipped' ? 'bg-blue-100 text-blue-600' : o.status === 'cancelled' ? 'bg-red-100 text-red-700' : 'bg-green-100 text-green-700'}`}>{o.status === 'shipped' ? 'dispatched' : o.status}</span>
                  </div>
                  <div className="grid grid-cols-1 sm:grid-cols-3 gap-3 mb-8">
                    <p className="flex items-center gap-2 bg-gray-50 p-3 rounded-2xl border text-[10px] font-black uppercase text-gray-500"><Phone size={14} className="text-orange-600" /> {o.customerPhone}</p>
                    <p className="flex items-center gap-2 bg-gray-50 p-3 rounded-2xl border text-[10px] font-black uppercase text-gray-500"><Mail size={14} className="text-orange-600" /> {o.customerEmail}</p>
                    <p className="flex items-center gap-2 bg-gray-50 p-3 rounded-2xl border text-[10px] font-black uppercase text-gray-500 sm:col-span-3"><MapPin size={14} className="text-orange-600" /> {o.governorate}, {o.district}, {o.village} — {o.addressDetails}</p>
                  </div>
                  <div className="space-y-3">
                    {o.items.map((it, idx) => {
                      const orderItemImage = products.find((p) => p.Product_ID === it.productId)?.image || (it as any).image || BRAND_LOGO_SRC;
                      return (
                      <div key={idx} className="flex justify-between items-center text-xs bg-gray-50 p-4 rounded-2xl border border-gray-100">
                        <div className="flex items-center gap-4">
                          <div className="w-10 h-10 rounded-xl border bg-white overflow-hidden flex items-center justify-center">
                            <SafeImage src={orderItemImage} alt={it.productName} className="w-full h-full object-contain p-1" />
                          </div>
                          <div>
                            <p className="font-black uppercase italic tracking-tighter text-black">{it.productName}</p>
                            <p className="text-[9px] font-bold text-gray-400 uppercase tracking-widest">Product_ID: {it.productId}</p>
                            <p className="text-[9px] font-bold text-gray-400 uppercase tracking-widest">Variant: {it.size}</p>
                          </div>
                        </div>
                        <span className="text-orange-600 font-black italic text-base">x{it.quantity}</span>
                      </div>
                    )})}
                  </div>
                </div>
                <div className="flex flex-col items-end justify-between md:min-w-[180px] bg-black text-white p-4 rounded-2xl shadow-2xl">
                  <div className="text-right">
                    <p className="text-[9px] text-orange-500 font-black uppercase tracking-widest mb-1 italic">Settlement Total</p>
                    <p className="text-2xl font-black italic tracking-tighter text-white">${o.total.toFixed(2)}</p>
                    <p className="text-[8px] text-gray-500 mt-1 font-bold uppercase">{new Date(o.date).toLocaleDateString()}</p>
                  </div>
                  <div className="flex flex-col gap-2 w-full mt-4">
                    {o.status === 'pending' && (
                      <button onClick={async () => {
                        try {
                          await updateOrderStatus(o.id, 'shipped');
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
                        } catch (error) {
                          console.error('Error updating order status:', error);
                          const message = error instanceof Error
                            ? error.message
                            : String((error as any)?.message || (error as any)?.details || (error as any)?.hint || 'Failed to update order status. Please try again.');
                          alert(message);
                        }
                      }} className="w-full bg-orange-600 text-white px-6 py-4 rounded-2xl text-[11px] font-black uppercase tracking-widest hover:bg-orange-700 transition-all shadow-xl shadow-orange-600/20">Approve / Dispatch Order</button>
                    )}
                    <button onClick={async () => { 
                      if(confirm('Erase this distribution record?')) {
                        try {
                          await deleteOrder(o.id);
                          const refreshedOrders = await getOrders();
                          setOrders(refreshedOrders);
                        } catch (error) {
                          console.error('Error deleting order:', error);
                          alert('Failed to delete order. Please try again.');
                        }
                      }
                    }} className="w-full py-2 text-gray-600 hover:text-red-500 text-[10px] font-black uppercase tracking-widest transition-all">Destroy Log</button>
                  </div>
                </div>
              </div>
            ))}
          </div>
        )}
      </div>
    );
  };

  const CheckoutView = () => {
    const [gov, setGov] = useState('');
    const [dist, setDist] = useState('');
    const [vill, setVill] = useState('');
    const [isProcessing, setIsProcessing] = useState(false);

    const handleSubmit = async (e: React.FormEvent<HTMLFormElement>) => {
      e.preventDefault();
      setIsProcessing(true);

      const checkoutItems = [...cart];

      if (checkoutItems.length === 0) {
        setIsProcessing(false);
        alert('Your cart is empty.');
        return;
      }

      for (const item of checkoutItems) {
        const expMs = item.expiresAt ? new Date(item.expiresAt).getTime() : 0;
        if (expMs > Date.now()) continue;

        if (!item.reservationId) {
          setCart(prev => prev.filter((it) => !(it.Product_ID === item.Product_ID && it.selectedSize === item.selectedSize)));
          setCartNotice('Some items in your cart have expired.');
          alert('Some items in your cart have expired');
          setIsProcessing(false);
          return;
        }

        const extension = await extendExpiredReservation(item.reservationId, undefined, 120);
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

      const fd = new FormData(e.currentTarget);
      const order: Order = {
        id: `ORD-${Date.now()}`,
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
  };

  const CartView = () => {
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
  };

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
            <div className="relative h-screen bg-black flex items-center justify-center overflow-hidden">
              <img 
                src="https://images.unsplash.com/photo-1556906781-9a412961c28c?auto=format&fit=crop&q=80&w=2000" 
                className="absolute inset-0 w-full h-full object-cover opacity-60 scale-105 animate-slow-zoom" 
                alt="Original Style" 
              />
              <div className="absolute inset-0 bg-gradient-to-t from-black via-transparent to-black/40"></div>
              <div className="relative text-center px-6 max-w-6xl z-10 pb-40">
                 <div className="inline-block px-8 py-3 bg-orange-600/20 backdrop-blur-md rounded-full border border-orange-600/30 mb-10 animate-fade-in-up">
                    <span className="text-orange-500 font-black uppercase tracking-[0.6em] text-[11px] italic">Authenticity Is Our Signature</span>
                 </div>
                 <h1 className="text-4xl md:text-6xl font-black text-white mb-8 tracking-tighter italic leading-tight drop-shadow-2xl animate-fade-in-up delay-100">
                    PURELY <br/><span className="text-orange-600">ORIGINAL</span>
                 </h1>
                 <div className="flex flex-col sm:flex-row gap-4 justify-center animate-fade-in-up delay-200">
                   <button onClick={() => {setView('shop'); window.scrollTo(0,0);}} className="bg-orange-600 text-white px-8 py-3 rounded-full font-black text-base hover:bg-white hover:text-black transition-all hover:scale-105 shadow-2xl shadow-orange-600/40 uppercase tracking-widest italic active:scale-95">Enter Store</button>
                   <a href="https://t.me/flexfitsbot" target="_blank" rel="noreferrer" className="inline-flex items-center justify-center bg-white/10 backdrop-blur-xl text-white border-2 border-white/20 px-8 py-3 rounded-full font-black text-base hover:bg-white hover:text-black transition-all uppercase tracking-widest italic active:scale-105">FlexFits Bot</a>
                 </div>
              </div>
            </div>

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
                    <div className="aspect-[4/5] bg-white flex items-center justify-center overflow-hidden">
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
                        const isSelected = productDetailSelectedSize === size;
                        const isUnavailable = sizeStock <= 0;
                        return (
                          <button key={size} type="button" onClick={() => { if (!isUnavailable) { setProductDetailSelectedSize(size); setProductDetailQuantity(1); } }} disabled={isUnavailable} className={`rounded-xl border px-3 py-3 text-[11px] font-black uppercase tracking-widest transition-all ${isSelected ? 'bg-black text-white border-black' : isUnavailable ? 'bg-gray-50 text-gray-300 border-gray-100 cursor-not-allowed' : 'bg-white text-gray-700 border-gray-200 hover:border-orange-500'}`}>
                            <span className="block">{size}</span>
                            <span className="mt-1 block text-[9px] font-bold normal-case tracking-normal">{sizeStock > 0 ? `${sizeStock} left` : 'Unavailable'}</span>
                          </button>
                        );
                      })}
                    </div>
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
                    <button type="button" disabled={!productDetailSelectedSize || getSizeStock(activeProduct, productDetailSelectedSize) <= 0} onClick={async () => {
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
                onClick={() => setIsMobileFilterOpen(true)}
                className="w-full bg-white border-2 border-gray-100 rounded-2xl px-4 py-3 flex items-center justify-between shadow-sm"
              >
                <span className="flex items-center gap-2 text-[11px] font-black uppercase tracking-wider text-gray-700 italic">
                  <Filter size={16} className="text-orange-600" />
                  Classification
                </span>
                <span className="text-[10px] font-black uppercase text-orange-600 tracking-widest">
                  {selectedGenders.length + selectedSizeFilters.length + selectedColorFilters.length + (hideSoldOutItems ? 1 : 0) + (filterCategory !== 'All' ? 1 : 0) + (maxPrice !== 150 ? 1 : 0)} Active
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
              {filterCategory === 'ComingSoon' ? (
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
                <div className="absolute inset-x-0 bottom-0 bg-white rounded-t-3xl border-t border-gray-100 shadow-2xl max-h-[85vh] overflow-y-auto">
                  <div className="sticky top-0 bg-white border-b border-gray-100 px-4 py-3 flex items-center justify-between">
                    <h3 className="font-black text-xs uppercase tracking-[0.4em] text-gray-500 italic">Classification</h3>
                    <button
                      onClick={() => setIsMobileFilterOpen(false)}
                      className="p-2 rounded-full text-orange-600 hover:bg-orange-50"
                      aria-label="Close filters"
                    >
                      <X size={16} />
                    </button>
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
                  Pinch or wheel to zoom
                </div>

                <div
                  onClick={(event) => event.stopPropagation()}
                  onWheel={handleImageViewerWheel}
                  onTouchStart={handleImageViewerTouchStart}
                  onTouchMove={handleImageViewerTouchMove}
                  onTouchEnd={handleImageViewerTouchEnd}
                  className="absolute inset-0 z-[91] flex items-center justify-center p-4 sm:p-8 touch-none"
                >
                  <img
                    src={imageViewerProduct.image}
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

        {view === 'admin' && <AdminPanel />}
        {view === 'cart' && <CartView />}
        {view === 'checkout' && <CheckoutView />}
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

export default App;
