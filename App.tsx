
import React, { useState, useEffect, useMemo, useRef } from 'react';
import { ShoppingBag, User, Search, Filter, Trash2, Plus, LogOut, ChevronRight, CheckCircle, Package, BarChart3, Menu, X, Star, ExternalLink, Edit2, Upload, Phone, MapPin, Truck, Check, Mail, List, Layers, Info } from 'lucide-react';
import { Category, Product, ProductGender, Order, CartItem, FinancialMetric, FinancialTotals, View } from './types';
import { INITIAL_PRODUCTS, ADMIN_USER, ADMIN_PASS, LEBANON_LOCATIONS, SIZE_OPTIONS } from './constants';
import { getProductRecommendation } from './services/gemini';
import { getProducts, saveProduct, deleteProduct, getOrders, saveOrder, updateOrderStatus, deleteOrder, recalculateFinancialMetrics, getFinancialDashboardTotals, reserveCartLine, releaseCartLineReservation, cleanupExpiredReservations, extendExpiredReservation } from './services/database';

const BRAND_LOGO_SRC = '/flex-logo.JPG';
const DELIVERY_FEE = 4;
const GENDER_OPTIONS: ProductGender[] = ['Men', 'Women', 'Unisex'];
const NUMERIC_SIZE_FILTER_OPTIONS = Array.from({ length: 16 }, (_, i) => String(35 + i));
const CLOTHING_SIZE_FILTER_OPTIONS = ['S', 'M', 'L', 'XL'];
const CART_STORAGE_KEY = 'flex_cart';

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

function viewFromPathname(pathname: string): View {
  const normalized = String(pathname || '/').toLowerCase();
  if (normalized === '/admin') return 'admin';
  if (normalized === '/shop') return 'shop';
  if (normalized === '/cart' || normalized === '/bag') return 'cart';
  if (normalized === '/checkout') return 'checkout';
  return 'home';
}

function pathnameFromView(view: View): string {
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

const FlexLogo = ({ className = "h-12" }: { className?: string }) => (
  <img
    src={BRAND_LOGO_SRC}
    alt="Flex Fits"
    className={`${className} w-auto object-contain`}
  />
);

const App: React.FC = () => {
  const currentYear = new Date().getFullYear();
  const [view, setView] = useState<View>('home');
  const [products, setProducts] = useState<Product[]>([]);
  const [orders, setOrders] = useState<Order[]>([]);
  const [cart, setCart] = useState<CartItem[]>(() => getInitialCartState());
  const [isAdmin, setIsAdmin] = useState(false);
  const [searchQuery, setSearchQuery] = useState('');
  const [filterCategory, setFilterCategory] = useState<Category | 'All'>('All');
  const [maxPrice, setMaxPrice] = useState<number>(200);
  const [selectedSizeFilters, setSelectedSizeFilters] = useState<string[]>([]);
  const [filterBrand, setFilterBrand] = useState<string>('All');
  const [hideSoldOutItems, setHideSoldOutItems] = useState<boolean>(false);
  const [selectedGenders, setSelectedGenders] = useState<ProductGender[]>([]);
  const [isSizeFilterExpanded, setIsSizeFilterExpanded] = useState<boolean>(false);
  const [isGenderFilterExpanded, setIsGenderFilterExpanded] = useState<boolean>(false);
  const [isMobileFilterOpen, setIsMobileFilterOpen] = useState<boolean>(false);
  const [quickAddProduct, setQuickAddProduct] = useState<Product | null>(null);
  const [cartNotice, setCartNotice] = useState<string>('');
  const [imageViewerProduct, setImageViewerProduct] = useState<Product | null>(null);
  const [imageViewerScale, setImageViewerScale] = useState<number>(1);
  const [imageViewerTranslate, setImageViewerTranslate] = useState<{ x: number; y: number }>({ x: 0, y: 0 });
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
          for (const product of INITIAL_PRODUCTS) {
            await saveProduct(product);
          }
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

    const productById = new Map(products.map((product) => [product.id, product]));
    setCart((prev) => {
      let changed = false;
      const next = prev
        .map((line) => {
          const latest = productById.get(line.id);
          if (!latest) {
            changed = true;
            return null;
          }
          return {
            ...latest,
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
      setView(viewFromPathname(window.location.pathname));
    };

    syncFromUrl();
    window.addEventListener('popstate', syncFromUrl);
    return () => window.removeEventListener('popstate', syncFromUrl);
  }, []);

  useEffect(() => {
    const targetPath = pathnameFromView(view);
    if (window.location.pathname !== targetPath) {
      window.history.replaceState({}, '', targetPath);
    }
  }, [view]);

  useEffect(() => {
    if (!isMobileFilterOpen && !quickAddProduct && !imageViewerProduct) return;

    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key === 'Escape') {
        setIsMobileFilterOpen(false);
        setQuickAddProduct(null);
        closeImageViewer();
      }
    };

    document.body.style.overflow = 'hidden';
    window.addEventListener('keydown', onKeyDown);

    return () => {
      document.body.style.overflow = '';
      window.removeEventListener('keydown', onKeyDown);
    };
  }, [isMobileFilterOpen, quickAddProduct, imageViewerProduct]);

  useEffect(() => {
    if (cart.length === 0) return;

    let isCancelled = false;

    const removeExpiredLines = async () => {
      const nowMs = Date.now();
      const expired = cart.filter((item) => {
        const exp = item.expiresAt ? new Date(item.expiresAt).getTime() : 0;
        return exp > 0 && exp <= nowMs;
      });

      if (expired.length === 0) return;

      const expiredKeys = new Set(expired.map((item) => `${item.id}::${item.selectedSize}::${item.reservationId || ''}`));

      setCart((prev) => prev.filter((item) => !expiredKeys.has(`${item.id}::${item.selectedSize}::${item.reservationId || ''}`)));
      setCartNotice(`${expired.length} item${expired.length > 1 ? 's were' : ' was'} removed due to timeout.`);

      for (const item of expired) {
        await releaseCartLineReservation(item.reservationId);
      }
      await cleanupExpiredReservations();

      if (!isCancelled) {
        const refreshedProducts = await getProducts();
        setProducts(refreshedProducts);
      }
    };

    void removeExpiredLines();

    const nextExpiryMs = cart
      .map((item) => (item.expiresAt ? new Date(item.expiresAt).getTime() : 0))
      .filter((value) => value > 0)
      .sort((a, b) => a - b)[0];

    if (!nextExpiryMs) {
      return () => {
        isCancelled = true;
      };
    }

    const timeoutMs = Math.max(200, nextExpiryMs - Date.now() + 40);
    const timeout = window.setTimeout(() => {
      void removeExpiredLines();
    }, timeoutMs);

    return () => {
      isCancelled = true;
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

    for (const p of products) {
      const brand = String(p.brandName || '').trim();
      if (brand) brands.add(brand);
    }

    return {
      brands: Array.from(brands).sort((a, b) => a.localeCompare(b, undefined, { sensitivity: 'base' })),
    };
  }, [products]);

  const filteredProducts = useMemo(() => {
    return products.filter(p => {
      const rawLeftStock = Number((p as any).Items_LEFT_in_stock ?? (p as any).items_left_in_stock ?? p.pieces);
      const leftStock = Number.isFinite(rawLeftStock) ? rawLeftStock : 0;
      const normalizedStatus = String((p as any).Status ?? p.status ?? '').trim().toLowerCase();
      const isSoldOut = leftStock <= 0 || normalizedStatus === 'out of stock';
      const productGender = normalizeGender(p.gender);

      const isTshirtOrHoodie = /t-?shirt|hoodie/i.test(p.type);
      const matchesSearch = (p.productName || p.name).toLowerCase().includes(searchQuery.toLowerCase());
      const matchesPrice = p.price <= maxPrice;
      const matchesSize = productMatchesSelectedSizes(p.sizes || [], selectedSizeFilters);
      const matchesBrand = filterBrand === 'All' || String(p.brandName || '').toLowerCase() === filterBrand.toLowerCase();
      const matchesGender = selectedGenders.length === 0 || selectedGenders.includes(productGender);

      if (filterCategory === ('ComingSoon' as any)) {
        return matchesSearch && isTshirtOrHoodie && matchesPrice && matchesSize && matchesBrand && matchesGender && !(hideSoldOutItems && isSoldOut);
      }

      const matchesCategory = filterCategory === 'All' || p.category === filterCategory;
      return matchesSearch && matchesCategory && matchesPrice && matchesSize && matchesBrand && matchesGender && !isTshirtOrHoodie && !(hideSoldOutItems && isSoldOut);
    });
  }, [products, searchQuery, filterCategory, maxPrice, selectedSizeFilters, filterBrand, selectedGenders, hideSoldOutItems]);

  const cartTotal = cart.reduce((acc, item) => acc + item.price * item.quantity, 0);
  const checkoutTotal = cart.length > 0 ? cartTotal + DELIVERY_FEE : 0;

  const addToCart = async (product: Product, size: string): Promise<boolean> => {
    const liveProduct = products.find(p => p.id === product.id);
    if (!liveProduct || liveProduct.pieces <= 0) {
      alert("This item is currently out of stock!");
      return false;
    }

    const existing = cart.find(i => i.id === product.id && i.selectedSize === size);
    const nextQuantity = existing ? existing.quantity + 1 : 1;

    let reservation = await reserveCartLine({
      productId: product.id,
      size,
      quantity: nextQuantity,
      existingReservationId: existing?.reservationId,
    });

    if ((!reservation.ok || !reservation.reservationId) && existing?.reservationId) {
      // If previous reservation id is stale, retry as fresh reservation for this line quantity.
      reservation = await reserveCartLine({
        productId: product.id,
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
      const existingIndex = prev.findIndex(i => i.id === product.id && i.selectedSize === size);
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
        quantity: 1,
        selectedSize: size,
        reservationId: reservation.reservationId,
        reservedAt: new Date().toISOString(),
        expiresAt: reservation.expiresAt,
      }];
    });

    setProducts(prev => prev.map((p) => {
      if (p.id !== product.id) return p;
      if (reservation.availableAfter !== undefined) {
        return { ...p, pieces: Math.max(0, Number(reservation.availableAfter || 0)) };
      }
      return { ...p, pieces: Math.max(0, Number(p.pieces || 0) - 1) };
    }));
    return true;
  };

  const handleCardAddToCart = (product: Product) => {
    const normalizedSizes = (product.sizes || []).map((s) => String(s).trim()).filter(Boolean);
    if (normalizedSizes.length <= 1) {
      void addToCart(product, normalizedSizes[0] || 'Default');
      return;
    }
    setQuickAddProduct(product);
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

  const removeFromCart = async (id: string, size: string) => {
    const line = cart.find((item) => item.id === id && item.selectedSize === size);
    await releaseCartLineReservation(line?.reservationId);
    setCart(prev => prev.filter(i => !(i.id === id && i.selectedSize === size)));
    const refreshedProducts = await getProducts();
    setProducts(refreshedProducts);
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

  const toggleGenderFilter = (genderOption: ProductGender, isEnabled: boolean) => {
    setSelectedGenders((prev) => {
      if (isEnabled) {
        if (prev.includes(genderOption)) return prev;
        return [...prev, genderOption];
      }
      return prev.filter((g) => g !== genderOption);
    });
  };

  const toggleSizeFilter = (sizeOption: string, isEnabled: boolean) => {
    const normalized = String(sizeOption || '').trim().toUpperCase();
    if (!normalized) return;
    setSelectedSizeFilters((prev) => {
      if (isEnabled) {
        if (prev.includes(normalized)) return prev;
        return [...prev, normalized];
      }
      return prev.filter((entry) => entry !== normalized);
    });
  };

  const renderFilterControls = () => (
    <>
      <div className="mb-4 p-3 bg-orange-50 border border-orange-100 rounded-xl">
        <p className="text-[9px] font-black uppercase tracking-[0.18em] mb-1 text-orange-600 italic">Trusted Sneaker Supplier</p>
        <p className="text-[10px] font-semibold leading-snug text-gray-700">Every product is guaranteed 100% original. Authentic or your money back.</p>
      </div>
      <div className="mb-6">
        <h3 className="font-black text-[10px] uppercase tracking-[0.35em] mb-4 text-gray-300 italic">Categories</h3>
        <div className="space-y-2">
          {['All', ...Object.values(Category)].map(c => (
            <button key={c} onClick={() => setFilterCategory(c as Category | 'All')} className={`block w-full text-left p-3 rounded-xl text-[10px] transition-all uppercase font-black italic tracking-[0.12em] ${filterCategory === c ? 'bg-black text-white shadow-xl border-2 border-black' : 'hover:bg-gray-50 text-gray-400 border-2 border-transparent'}`}>
              {c} Selection
            </button>
          ))}
        </div>
        <button onClick={() => setFilterCategory('ComingSoon')} className="w-full text-left p-3 rounded-xl text-[10px] transition-all uppercase font-black italic tracking-[0.12em] bg-gradient-to-r from-orange-600/20 to-orange-500/20 text-orange-600 border-2 border-orange-600/50 hover:border-orange-600 mt-2 flex items-center justify-center gap-1.5">
          <span>👕 T-shirts & Hoodies</span>
          <span className="text-[8px] bg-orange-600 text-white px-1.5 py-0.5 rounded-full">Coming Soon</span>
        </button>
      </div>
      <div className="pt-4 border-t-2 border-gray-50">
        <h3 className="font-black text-[10px] uppercase tracking-[0.35em] mb-4 text-gray-300 italic">Price Filter</h3>
        <div className="px-2">
          <input type="range" min="0" max="200" step="5" value={maxPrice} onChange={(e) => setMaxPrice(Number(e.target.value))} className="w-full h-1.5 bg-gray-100 rounded-lg appearance-none cursor-pointer accent-orange-600" />
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
      <div className="pt-4 border-t-2 border-gray-50 space-y-3">
        <h3 className="font-black text-[10px] uppercase tracking-[0.35em] text-gray-300 italic">Brands</h3>
        <select value={filterBrand} onChange={(e) => setFilterBrand(e.target.value)} className="w-full p-2.5 border rounded-xl bg-white text-[9px] font-black uppercase focus:ring-2 focus:ring-orange-500 outline-none">
          <option value="All">All Brands</option>
          {filterOptions.brands.map((brand) => (
            <option key={brand} value={brand}>{brand}</option>
          ))}
        </select>
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
    const [uploadedImg, setUploadedImg] = useState<string>('');
    const [formCategory, setFormCategory] = useState<Category>(Category.SHOES);
    const [selectedSizes, setSelectedSizes] = useState<string[]>([]);
    const [brandName, setBrandName] = useState('');
    const [productName, setProductName] = useState('');
    const [inventorySection, setInventorySection] = useState<InventorySection>('All');
    const [inventorySort, setInventorySort] = useState<{ col: 'id' | 'productName' | 'category'; dir: 'asc' | 'desc' } | null>(null);
    const [financialMetrics, setFinancialMetrics] = useState<FinancialMetric[]>([]);
    const [financialTotals, setFinancialTotals] = useState<FinancialTotals | null>(null);
    const fileRef = useRef<HTMLInputElement>(null);
    const isShoesCategory = formCategory === Category.SHOES;

    const cycleSort = (col: 'id' | 'productName' | 'category') => {
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
        const match = /^FF-(\d{3,4})$/i.exec(String(p.id || ''));
        if (!match) return max;
        return Math.max(max, Number(match[1]));
      }, 100);
      return `FF-${Math.min(9999, maxExisting + 1)}`;
    };

    useEffect(() => {
      if (editMode) {
        setFormCategory(editMode.category);
        setSelectedSizes(editMode.sizes);
        const parsed = splitDisplayName(editMode.name);
        setBrandName(editMode.brandName || parsed.brand);
        setProductName(editMode.productName || parsed.product);
        setActiveTab('add');
      } else {
        setSelectedSizes([]);
        setBrandName('');
        setProductName('');
      }
    }, [editMode]);

    useEffect(() => {
      if (!isAdmin) return;

      const syncFinancialMetrics = async () => {
        try {
          const metrics = await recalculateFinancialMetrics();
          setFinancialMetrics(metrics);
          const totals = await getFinancialDashboardTotals();
          setFinancialTotals(totals);
        } catch (error) {
          console.error('Error syncing financial metrics:', error);
        }
      };

      syncFinancialMetrics();
    }, [isAdmin, products]);

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
          const va = col === 'id' ? a.id : col === 'productName' ? (a.productName || a.name) : a.category;
          const vb = col === 'id' ? b.id : col === 'productName' ? (b.productName || b.name) : b.category;
          const cmp = va.localeCompare(vb, undefined, { numeric: true, sensitivity: 'base' });
          return dir === 'asc' ? cmp : -cmp;
        });
      }
      return list;
    }, [products, inventorySection, inventorySort]);

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

    const handleFile = (e: React.ChangeEvent<HTMLInputElement>) => {
      const file = e.target.files?.[0];
      if (file) {
        const reader = new FileReader();
        reader.onloadend = () => setUploadedImg(reader.result as string);
        reader.readAsDataURL(file);
      }
    };

    const saveProduct = async (e: React.FormEvent<HTMLFormElement>) => {
      e.preventDefault();
      // Capture form element immediately — e.currentTarget becomes null after any await
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
      const pieces = Number(fd.get('pieces'));
      const productId = editMode?.id || generateNextProductId();
      
      const newP: Product = {
        id: productId,
        name: `${normalizedBrand} - ${normalizedProduct}`,
        brandName: normalizedBrand,
        productName: normalizedProduct,
        gender: normalizeGender(fd.get('gender')),
        category: formCategory,
        type: fd.get('type') as string,
        price: Number(fd.get('price')),
        cost: Number(fd.get('cost')),
        initialStock: editMode ? editMode.initialStock : pieces,
        pieces: pieces,
        sold: editMode ? editMode.sold : 0,
        sizes: selectedSizes,
        description: fd.get('description') as string,
        image: uploadedImg || (fd.get('image') as string) || (editMode?.image || ''),
        isAuthentic: true,
        status: (fd.get('status') as string) || 'Active'
      };
      
      try {
        await syncProductToDatabase(newP);
        const refreshedProducts = await getProducts();
        setProducts(refreshedProducts);
        setEditMode(null);
        setUploadedImg('');
        setSelectedSizes([]);
        setBrandName('');
        setProductName('');
        setActiveTab('inventory');
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
                <span className="text-[10px] bg-gray-900 text-white px-3 py-1 rounded-full font-bold uppercase">{inventoryProducts.length} Visible</span>
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
                      <button onClick={() => cycleSort('id')} className="flex items-center gap-1 hover:text-gray-900 transition-colors">
                        Product_ID
                        <span className="text-[10px] leading-none">{inventorySort?.col === 'id' ? (inventorySort.dir === 'asc' ? '▲' : '▼') : '⇅'}</span>
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
                    <th className="p-3">Cost</th>
                    <th className="p-3">Price</th>
                    <th className="p-3">Stock</th>
                    <th className="p-3">Items_LEFT_in_stock</th>
                    <th className="p-3">Items_Sold</th>
                    <th className="p-3">Status</th>
                    <th className="p-3">Pictures</th>
                    <th className="p-3">Description</th>
                    <th className="p-3 text-right">Actions</th>
                  </tr>
                </thead>
                <tbody className="divide-y">
                  {inventoryProducts.map(p => {
                    const stockStatus = p.pieces <= 0 ? 'Out of Stock' : p.pieces < 10 ? 'Low Stock' : 'Healthy';
                    const normalizedStatus = (p.status === 'Temporary Not Available' || p.status === 'Temporarily unavailable') ? 'Out of Stock' : (p.status || stockStatus);
                    return (
                      <tr key={p.id} className="hover:bg-gray-50 transition-colors">
                        <td className="p-3 font-bold text-gray-700">{p.id}</td>
                        <td className="p-3 font-semibold text-gray-900">{p.brandName || splitDisplayName(p.name).brand || '-'}</td>
                        <td className="p-3 font-semibold text-gray-900">{p.productName || splitDisplayName(p.name).product || '-'}</td>
                        <td className="p-3 text-gray-700">{p.category}</td>
                        <td className="p-3 text-gray-700">{normalizeGender(p.gender)}</td>
                        <td className="p-3 text-gray-700">{p.type}</td>
                        <td className="p-3 text-gray-700">{p.sizes.join(', ') || '-'}</td>
                        <td className="p-3 text-gray-700">${p.cost}</td>
                        <td className="p-3 font-bold text-gray-900">${p.price}</td>
                        <td className="p-3 text-gray-700">{p.initialStock}</td>
                        <td className="p-3 font-bold text-orange-600">{p.pieces}</td>
                        <td className="p-3 text-blue-600 font-bold">{p.sold}</td>
                        <td className="p-3">
                          <span className={`px-2 py-1 rounded text-[10px] font-bold uppercase ${normalizedStatus === 'Out of Stock' ? 'bg-red-50 text-red-700' : 'bg-blue-50 text-blue-700'}`}>
                            {normalizedStatus}
                          </span>
                        </td>
                        <td className="p-3">
                          <div className="flex items-center gap-2">
                            <div className="w-9 h-9 rounded border overflow-hidden bg-gray-50">
                              <img src={p.image} className="w-full h-full object-cover" alt={p.name} />
                            </div>
                            <span className="text-[10px] text-gray-500 max-w-[180px] truncate">{p.image || '-'}</span>
                          </div>
                        </td>
                        <td className="p-3 max-w-[260px]">
                          <p className="text-[10px] text-gray-600 leading-relaxed line-clamp-3">{p.description || '-'}</p>
                        </td>
                        <td className="p-3 text-right">
                          <div className="flex justify-end gap-1">
                            <button onClick={() => { setEditMode(p); setUploadedImg(''); }} className="p-2 hover:bg-orange-50 text-gray-400 hover:text-orange-600 rounded-lg transition-colors"><Edit2 size={14} /></button>
                            <button onClick={async () => { 
                              if(confirm('Permanently erase this asset?')) {
                                try {
                                  await deleteProduct(p.id);
                                  const refreshedProducts = await getProducts();
                                  setProducts(refreshedProducts);
                                } catch (error) {
                                  console.error('Error deleting product:', error);
                                  alert('Failed to delete product. Please try again.');
                                }
                              }
                            }} className="p-2 hover:bg-red-50 text-gray-400 hover:text-red-600 rounded-lg transition-colors"><Trash2 size={14} /></button>
                          </div>
                        </td>
                      </tr>
                    );
                  })}
                  {inventoryProducts.length === 0 && (
                    <tr>
                      <td colSpan={16} className="p-6 text-center text-gray-500 font-semibold">
                        {inventorySection === 'ComingSoon'
                          ? 'No T-shirt or Hoodie products found yet. Add items with type containing "tshirt", "t-shirt", or "hoodie".'
                          : 'No products in this section.'}
                      </td>
                    </tr>
                  )}
                </tbody>
              </table>
            </div>
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
                    value={editMode?.id || generateNextProductId()}
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
                  <label className="text-[10px] font-black uppercase text-gray-400 ml-1">Current Stock (Items Left)</label>
                  <input name="pieces" type="number" defaultValue={editMode?.pieces} placeholder="Total Pieces" className="w-full p-4 bg-gray-50 border rounded-2xl text-sm font-bold outline-none" required />
                </div>
              </div>

              <div className="space-y-6">
                <div>
                  <label className="text-[10px] font-black uppercase text-gray-400 ml-1">Asset Description</label>
                  <textarea name="description" defaultValue={editMode?.description} placeholder="Enter full product details and authenticity notes..." rows={4} className="w-full p-4 bg-gray-50 border rounded-2xl text-sm font-bold focus:ring-2 focus:ring-orange-500 outline-none" required></textarea>
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
                    <input name="image" placeholder="Or paste URL..." defaultValue={editMode?.image} className="flex-[2] p-4 bg-gray-50 border rounded-2xl text-sm font-bold outline-none" />
                    <input type="file" ref={fileRef} hidden accept="image/*" onChange={handleFile} />
                  </div>
                  {uploadedImg && (
                    <div className="mt-2 rounded-2xl border overflow-hidden bg-gray-50 h-20 flex items-center">
                      <img src={uploadedImg} className="h-full object-contain" />
                    </div>
                  )}
                </div>
                <div className="flex gap-4 pt-4">
                  <button type="submit" className="flex-1 bg-orange-600 text-white py-3 rounded-xl font-black uppercase tracking-widest hover:bg-orange-700 hover:scale-[1.02] transition-all shadow-xl shadow-orange-600/20 text-sm">{editMode ? 'Commit Changes' : 'Publish Asset'}</button>
                  {editMode && <button type="button" onClick={() => {setEditMode(null); setUploadedImg(''); setBrandName(''); setProductName(''); setActiveTab('inventory');}} className="px-8 bg-gray-100 rounded-3xl font-black uppercase text-[10px] tracking-widest">Cancel</button>}
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
                    {o.items.map((it, idx) => (
                      <div key={idx} className="flex justify-between items-center text-xs bg-gray-50 p-4 rounded-2xl border border-gray-100">
                        <div className="flex items-center gap-4">
                          <div className="w-10 h-10 rounded-xl border bg-white overflow-hidden flex items-center justify-center">
                            <img src={BRAND_LOGO_SRC} alt="Flex Fits" className="w-full h-full object-contain p-1" />
                          </div>
                          <div>
                            <p className="font-black uppercase italic tracking-tighter text-black">{it.productName}</p>
                            <p className="text-[9px] font-bold text-gray-400 uppercase tracking-widest">Product_ID: {it.productId}</p>
                            <p className="text-[9px] font-bold text-gray-400 uppercase tracking-widest">Variant: {it.size}</p>
                          </div>
                        </div>
                        <span className="text-orange-600 font-black italic text-base">x{it.quantity}</span>
                      </div>
                    ))}
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
          setCart(prev => prev.filter((it) => !(it.id === item.id && it.selectedSize === item.selectedSize)));
          setCartNotice('Some items in your cart have expired.');
          alert('Some items in your cart have expired');
          setIsProcessing(false);
          return;
        }

        const extension = await extendExpiredReservation(item.reservationId, undefined, 120);
        if (!extension.ok || !extension.expiresAt) {
          await releaseCartLineReservation(item.reservationId);
          setCart(prev => prev.filter((it) => !(it.id === item.id && it.selectedSize === item.selectedSize)));
          setCartNotice('Some items in your cart have expired.');
          alert('Some items in your cart have expired');
          setIsProcessing(false);
          return;
        }

        item.expiresAt = extension.expiresAt;
      }

      setCart((prev) => prev.map((item) => {
        const refreshed = checkoutItems.find((line) => line.id === item.id && line.selectedSize === item.selectedSize);
        return refreshed ? { ...item, expiresAt: refreshed.expiresAt } : item;
      }));
      
      for (const item of checkoutItems) {
        const prod = products.find(p => p.id === item.id);
        if (!prod || prod.pieces < item.quantity) {
          alert(`Notice: Availability for "${item.productName || item.name}" has updated. Current stock: ${prod?.pieces || 0}.`);
          setIsProcessing(false);
          return;
        }
      }

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
        items: checkoutItems.map(i => ({ productId: i.id, productName: i.productName || i.name, quantity: i.quantity, size: i.selectedSize, price: i.price, reservationId: i.reservationId })),
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
                    <img src={it.image} className="w-full h-full object-contain p-2 transition-transform duration-700 group-hover:scale-[1.03]" alt={it.name} />
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
                    <button onClick={() => void removeFromCart(it.id, it.selectedSize)} className="p-3 bg-gray-50 text-gray-200 hover:text-red-500 hover:bg-red-50 rounded-2xl transition-all">
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
                  {selectedGenders.length + (filterBrand !== 'All' ? 1 : 0) + selectedSizeFilters.length + (hideSoldOutItems ? 1 : 0)} Active
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
                {filteredProducts.map(p => {
                  const isOutOfStock = p.pieces <= 0 || p.status === 'Temporary Not Available' || p.status === 'Temporarily unavailable' || p.status === 'Out of Stock';
                  return (
                    <div key={p.id} className={`group bg-white p-3 sm:p-4 rounded-2xl border-2 border-gray-50 shadow-sm hover:shadow-3xl transition-all duration-700 flex flex-col h-full relative overflow-hidden min-w-0 ${isOutOfStock ? 'opacity-80' : ''}`}>
                       <div className="relative aspect-[4/5] rounded-xl overflow-hidden mb-4 bg-white border border-gray-100 flex-shrink-0">
                         <button
                          onClick={() => openImageViewer(p)}
                          aria-label={`View ${p.productName || p.name} image`}
                          className="absolute inset-0 z-10"
                         />
                         <img src={p.image} className={`w-full h-full object-contain p-2 group-hover:scale-[1.03] transition-transform duration-700 ${isOutOfStock ? 'grayscale' : ''}`} alt={p.name} />
                         <div className="absolute top-2 left-2 bg-white/95 backdrop-blur-md text-[8px] font-black px-2 py-1 rounded-full uppercase text-orange-600 shadow-xl border border-orange-100 tracking-[0.1em] italic">{p.type}</div>
                         {isOutOfStock && (
                            <div className="absolute inset-0 bg-black/70 flex items-center justify-center p-4 text-center backdrop-blur-sm">
                             <span className="bg-red-600 text-white font-black text-xs uppercase tracking-[0.3em] px-4 py-2 rounded-full shadow-2xl animate-pulse italic">Sold Out</span>
                            </div>
                         )}
                         <div className="absolute bottom-2 right-2 bg-black/90 backdrop-blur-md text-white px-3 py-1.5 rounded-xl font-black text-base italic tracking-tighter shadow-xl border border-white/10">
                           ${p.price}
                         </div>
                      </div>
                      <div className="px-2 pb-2 flex-grow flex flex-col">
                         <h4 className="font-black text-lg uppercase italic tracking-tighter group-hover:text-orange-600 transition-colors mb-1 text-black leading-none">{p.productName || p.name}</h4>
                         <p className="text-[9px] text-gray-300 font-black uppercase tracking-[0.3em] mb-3 italic">{p.category}</p>
                         
                         {/* Description Section */}
                         {p.description && (
                           <div className="mb-3 bg-gray-50 p-3 rounded-xl border border-gray-100">
                             <p className="text-[11px] text-gray-500 font-medium leading-relaxed italic line-clamp-2">{p.description}</p>
                           </div>
                         )}
                         {/* Items Left */}
                         <div className="mb-3 flex items-center gap-2">
                           <span className="text-[9px] font-black uppercase text-gray-400 tracking-widest">In Stock:</span>
                           <span className={`text-[11px] font-black ${p.pieces <= 0 ? 'text-red-500' : p.pieces < 10 ? 'text-orange-500' : 'text-green-600'}`}>
                             {isOutOfStock ? 'Sold Out' : `${p.pieces} left`}
                           </span>
                         </div>

                         <div className="mt-auto pt-3 border-t border-gray-50">
                            <div className="mb-2 flex items-center justify-between gap-2">
                              <p className="text-[9px] font-black uppercase text-gray-300 tracking-widest italic ml-1">Available Variants</p>
                              <button
                                onClick={() => handleCardAddToCart(p)}
                                disabled={isOutOfStock}
                                aria-label={`Add ${p.productName || p.name} to bag`}
                                className="inline-flex items-center gap-1.5 bg-orange-600 text-white px-2.5 py-1.5 rounded-lg text-[9px] font-black uppercase tracking-wider hover:bg-orange-700 transition-all disabled:opacity-40 disabled:cursor-not-allowed"
                              >
                                <ShoppingBag size={12} />
                                Add to Cart
                              </button>
                            </div>
                            <div className="flex flex-wrap gap-2">
                               {p.sizes.map(s => (
                                 <span key={s} className={`w-10 h-10 border-2 border-gray-100 rounded-lg flex items-center justify-center text-[9px] font-black uppercase italic select-none ${isOutOfStock ? 'opacity-30' : 'text-gray-500 bg-white'}`}>
                                   {s}
                                 </span>
                               ))}
                            </div>
                         </div>
                      </div>
                    </div>
                  );
                })}
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
                      className="text-[11px] font-black uppercase tracking-wider text-orange-600"
                    >
                      Done
                    </button>
                  </div>
                  <div className="p-4">
                    {renderFilterControls()}
                  </div>
                </div>
              </div>
            )}

            {quickAddProduct && (
              <div className="fixed inset-0 z-[80] flex items-end sm:items-center justify-center p-3 sm:p-4">
                <button
                  aria-label="Close size picker"
                  onClick={() => setQuickAddProduct(null)}
                  className="absolute inset-0 bg-black/45 backdrop-blur-[1px]"
                />
                <div className="relative w-full max-w-sm bg-white rounded-2xl border border-gray-100 shadow-2xl p-4 sm:p-5">
                  <h3 className="text-sm font-black uppercase tracking-wider text-gray-700 mb-1">Choose Size</h3>
                  <p className="text-xs text-gray-500 mb-4">{quickAddProduct.productName || quickAddProduct.name}</p>
                  <div className="grid grid-cols-4 gap-2 mb-4">
                    {(quickAddProduct.sizes || []).map((sizeValue) => (
                      <button
                        key={sizeValue}
                        onClick={async () => {
                          const added = await addToCart(quickAddProduct, sizeValue);
                          if (added) setQuickAddProduct(null);
                        }}
                        className="h-10 rounded-lg border-2 border-gray-100 text-[10px] font-black uppercase hover:bg-black hover:text-white hover:border-black transition-all"
                      >
                        {sizeValue}
                      </button>
                    ))}
                  </div>
                  <button
                    onClick={() => setQuickAddProduct(null)}
                    className="w-full h-10 rounded-xl border border-gray-200 text-[11px] font-black uppercase tracking-wider text-gray-600 hover:bg-gray-50 transition-colors"
                  >
                    Cancel
                  </button>
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
