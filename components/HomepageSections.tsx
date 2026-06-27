import React, { useEffect, useMemo, useRef, useState } from 'react';
import { ChevronRight } from 'lucide-react';
import { HomepageSectionSetting, Product, View } from '../types';
import { getVisibleHomepageSectionSettings } from '../services/database';
import { supabase } from '../services/supabase';

// Small local copies of App.tsx's pure display helpers (getProductImages / getProductBrandLabel /
// SafeImage) -- duplicated rather than imported to avoid a circular import with App.tsx, which
// is what renders this component.
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

function isRenderableImageSrc(value: string): boolean {
  if (!value) return false;
  if (/^https?:\/\//i.test(value)) return true;
  // Bounded length keeps this from matching base64 fragments that happen to satisfy this
  // character class otherwise (real local asset paths are always short).
  if (value.length <= 200 && /^\/[\w./%+-]+$/i.test(value)) return true;
  return /^data:image\/[a-z0-9.+-]+;base64,[a-z0-9+/=]+$/i.test(value);
}

function SafeImage({ src, alt, className }: { src: string; alt: string; className?: string }) {
  const [failed, setFailed] = useState(false);
  const normalizedSrc = String(src || '').trim();

  useEffect(() => {
    setFailed(false);
  }, [normalizedSrc]);

  const resolved = !failed && isRenderableImageSrc(normalizedSrc) ? normalizedSrc : '/flex-logo-bbg.JPG';
  return <img src={resolved} alt={alt} loading="lazy" className={className} onError={() => setFailed(true)} />;
}

type HomepageSectionsProps = {
  products: Product[];
  setView: React.Dispatch<React.SetStateAction<View>>;
  openProduct: (product: Product) => void;
  setSelectedBrands: React.Dispatch<React.SetStateAction<string[]>>;
  setShowOnSaleOnly: React.Dispatch<React.SetStateAction<boolean>>;
};

const MAX_TILES = 8;
const MAX_BRANDS = 6;

function isPurchasable(product: Product): boolean {
  const status = String((product as any).Status ?? product.status ?? '').trim().toLowerCase();
  return status !== 'discontinued' && Number(product.pieces || 0) > 0;
}

type BrandHighlight = { brand: string; product: Product };

function buildSectionProducts(section: HomepageSectionSetting, products: Product[]): Product[] {
  const purchasable = products.filter(isPurchasable);

  // A tag-linked section (Tags admin -> assigned to products -> linked here) always overrides
  // the built-in sectionKey behavior, so any section can become a Shopify-collection-style group.
  if (section.tagId) {
    return purchasable.filter((p) => Array.isArray(p.tagIds) && p.tagIds.includes(section.tagId as string)).slice(0, MAX_TILES);
  }

  if (section.sectionKey === 'featured_products') {
    return purchasable.slice(0, MAX_TILES);
  }

  if (section.sectionKey === 'new_arrivals') {
    return [...purchasable]
      .sort((a, b) => new Date(b.createdAt || 0).getTime() - new Date(a.createdAt || 0).getTime())
      .slice(0, MAX_TILES);
  }

  if (section.sectionKey === 'best_sellers') {
    const ranked = [...purchasable].filter((p) => Number(p.sold || 0) > 0).sort((a, b) => Number(b.sold || 0) - Number(a.sold || 0));
    return ranked.slice(0, MAX_TILES);
  }

  if (section.sectionKey === 'sale_collection') {
    return purchasable.filter((p) => p.onSale && p.originalPrice && p.originalPrice > p.price).slice(0, MAX_TILES);
  }

  return [];
}

function buildBrandHighlights(products: Product[]): BrandHighlight[] {
  const purchasable = products.filter(isPurchasable);
  const seen = new Map<string, Product>();
  for (const product of purchasable) {
    const brand = getProductBrandLabel(product);
    if (!brand || seen.has(brand)) continue;
    seen.set(brand, product);
  }
  return Array.from(seen.entries())
    .sort((a, b) => a[0].localeCompare(b[0], undefined, { sensitivity: 'base' }))
    .slice(0, MAX_BRANDS)
    .map(([brand, product]) => ({ brand, product }));
}

function ProductTile({ product, onOpen }: { product: Product; onOpen: () => void }) {
  const image = getProductImages(product)[0] || product.image;
  const onSale = Boolean(product.onSale && product.originalPrice && product.originalPrice > product.price);
  return (
    <button
      type="button"
      onClick={onOpen}
      className="group flex-shrink-0 w-40 sm:w-48 text-left bg-white border border-gray-100 rounded-2xl overflow-hidden hover:border-orange-400 hover:shadow-lg transition-all"
    >
      <div className="aspect-square bg-white border-b border-gray-50 overflow-hidden">
        <SafeImage src={image} alt={product.productName || product.name} className="w-full h-full object-contain p-3 group-hover:scale-105 transition-transform duration-500" />
      </div>
      <div className="p-3">
        <p className="text-[8px] font-black uppercase tracking-[0.25em] text-gray-300 truncate">{getProductBrandLabel(product)}</p>
        <p className="text-xs font-black uppercase italic tracking-tight text-black truncate mb-1">{product.productName || product.name}</p>
        {onSale ? (
          <div className="flex items-center gap-1.5">
            <span className="text-sm font-black text-black">${product.price.toFixed(2)}</span>
            <span className="text-[10px] font-bold text-gray-400 line-through">${(product.originalPrice as number).toFixed(2)}</span>
          </div>
        ) : (
          <span className="text-sm font-black text-black">${product.price.toFixed(2)}</span>
        )}
      </div>
    </button>
  );
}

function BrandTile({ highlight, onOpen }: { highlight: BrandHighlight; onOpen: () => void }) {
  const image = getProductImages(highlight.product)[0] || highlight.product.image;
  return (
    <button
      type="button"
      onClick={onOpen}
      className="group relative flex-shrink-0 w-36 sm:w-44 aspect-square rounded-2xl overflow-hidden border border-gray-100 hover:border-orange-400 transition-all"
    >
      <SafeImage src={image} alt={highlight.brand} className="w-full h-full object-contain p-4 bg-white group-hover:scale-105 transition-transform duration-500" />
      <div className="absolute inset-x-0 bottom-0 bg-black/75 px-2 py-1.5">
        <p className="text-[10px] font-black uppercase italic tracking-wider text-white truncate text-center">{highlight.brand}</p>
      </div>
    </button>
  );
}

export default function HomepageSections({ products, setView, openProduct, setSelectedBrands, setShowOnSaleOnly }: HomepageSectionsProps) {
  const [sections, setSections] = useState<HomepageSectionSetting[]>([]);
  const fetchInFlightRef = useRef(false);

  const refresh = async () => {
    if (fetchInFlightRef.current) return;
    fetchInFlightRef.current = true;
    try {
      const visible = await getVisibleHomepageSectionSettings();
      setSections(visible);
    } catch (error) {
      console.error('Error loading homepage sections:', error);
    } finally {
      fetchInFlightRef.current = false;
    }
  };

  useEffect(() => {
    void refresh();
  }, []);

  useEffect(() => {
    if (!supabase) return;
    const client = supabase;
    const channel = client
      .channel('flexfits-homepage-sections-live')
      .on('postgres_changes', { event: '*', schema: 'public', table: 'homepage_section_settings' }, () => {
        void refresh();
      })
      .subscribe();

    return () => {
      void client.removeChannel(channel);
    };
  }, []);

  const brandHighlights = useMemo(() => buildBrandHighlights(products), [products]);

  const goShopAll = (apply?: () => void) => {
    apply?.();
    setView('shop');
    window.scrollTo(0, 0);
  };

  const renderableSections = sections
    .map((section) => {
      const isBrandHighlights = section.sectionKey === 'brand_highlights' && !section.tagId;
      return {
        section,
        isBrandHighlights,
        sectionProducts: isBrandHighlights ? [] : buildSectionProducts(section, products),
      };
    })
    .filter(({ isBrandHighlights, sectionProducts }) => (isBrandHighlights ? brandHighlights.length >= 2 : sectionProducts.length > 0));

  if (renderableSections.length === 0) return null;

  return (
    <div className="bg-gray-50 py-16 border-y-4 border-gray-50 overflow-x-hidden">
      <div className="max-w-7xl mx-auto px-4 md:px-8 min-w-0 space-y-12">
        {renderableSections.map(({ section, isBrandHighlights, sectionProducts }) => (
          <div key={section.id} className="min-w-0">
            <div className="flex items-end justify-between gap-3 mb-4 min-w-0">
              <div className="min-w-0">
                <h3 className="text-xl sm:text-2xl font-black uppercase italic tracking-tighter text-black truncate">{section.title}</h3>
                {section.subtitle && <p className="text-gray-400 text-xs font-medium mt-1 truncate">{section.subtitle}</p>}
              </div>
              <button
                type="button"
                onClick={() => goShopAll(section.sectionKey === 'sale_collection' && !section.tagId ? () => setShowOnSaleOnly(true) : undefined)}
                className="flex-shrink-0 inline-flex items-center gap-1 text-[10px] font-black uppercase tracking-widest text-orange-600 hover:text-orange-700"
              >
                Shop All <ChevronRight size={14} />
              </button>
            </div>

            <div className="flex gap-3 overflow-x-auto pb-2 -mx-1 px-1 snap-x snap-mandatory">
              {isBrandHighlights
                ? brandHighlights.map((highlight) => (
                    <div key={highlight.brand} className="snap-start">
                      <BrandTile highlight={highlight} onOpen={() => goShopAll(() => setSelectedBrands([highlight.brand]))} />
                    </div>
                  ))
                : sectionProducts.map((product) => (
                    <div key={product.Product_ID} className="snap-start">
                      <ProductTile product={product} onOpen={() => openProduct(product)} />
                    </div>
                  ))}
            </div>
          </div>
        ))}
      </div>
    </div>
  );
}
