import React, { useEffect, useRef, useState } from 'react';
import { HeroSlide, View } from '../types';
import { getActiveHeroSlides } from '../services/database';
import { supabase } from '../services/supabase';

const ROTATE_INTERVAL_MS = 6000;

function isExternalLink(url: string): boolean {
  return /^https?:\/\//i.test(url);
}

function StaticFallbackHero({ setView }: { setView: React.Dispatch<React.SetStateAction<View>> }) {
  return (
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
          <button onClick={() => { setView('shop'); window.scrollTo(0, 0); }} className="bg-orange-600 text-white px-8 py-3 rounded-full font-black text-base hover:bg-white hover:text-black transition-all hover:scale-105 shadow-2xl shadow-orange-600/40 uppercase tracking-widest italic active:scale-95">Enter Store</button>
        </div>
      </div>
    </div>
  );
}

function HeroSlideContent({ slide }: { slide: HeroSlide }) {
  const buttonLink = String(slide.buttonLink || '').trim();
  const hasButton = Boolean(String(slide.buttonText || '').trim() && buttonLink);

  return (
    <div className="relative h-screen w-full flex-shrink-0 bg-black overflow-hidden">
      <picture>
        {slide.mobileImageUrl && (
          <source media="(max-width: 767px)" srcSet={slide.mobileImageUrl} />
        )}
        <img
          src={slide.desktopImageUrl}
          alt={slide.title || 'Flex Fits hero banner'}
          className="absolute inset-0 w-full h-full object-cover"
        />
      </picture>
      <div className="absolute inset-0 bg-gradient-to-t from-black via-black/30 to-black/40"></div>
      {(slide.title || slide.subtitle || hasButton) && (
        <div className="relative h-full flex items-center justify-center text-center px-6 max-w-6xl mx-auto z-10 pb-24">
          <div>
            {slide.title && (
              <h1 className="text-4xl md:text-6xl font-black text-white mb-6 tracking-tighter italic leading-tight drop-shadow-2xl">
                {slide.title}
              </h1>
            )}
            {slide.subtitle && (
              <p className="text-white/90 text-sm md:text-lg font-semibold max-w-2xl mx-auto mb-8 leading-relaxed">
                {slide.subtitle}
              </p>
            )}
            {hasButton && (
              <a
                href={buttonLink}
                target={isExternalLink(buttonLink) ? '_blank' : undefined}
                rel={isExternalLink(buttonLink) ? 'noreferrer' : undefined}
                className="inline-flex items-center justify-center bg-orange-600 text-white px-8 py-3 rounded-full font-black text-base hover:bg-white hover:text-black transition-all hover:scale-105 shadow-2xl shadow-orange-600/40 uppercase tracking-widest italic active:scale-95"
              >
                {slide.buttonText}
              </a>
            )}
          </div>
        </div>
      )}
    </div>
  );
}

export default function HeroBannerSlider({ setView }: { setView: React.Dispatch<React.SetStateAction<View>> }) {
  const [slides, setSlides] = useState<HeroSlide[]>([]);
  const [activeIndex, setActiveIndex] = useState(0);
  const [hasLoaded, setHasLoaded] = useState(false);
  const fetchInFlightRef = useRef(false);

  const refresh = async () => {
    if (fetchInFlightRef.current) return;
    fetchInFlightRef.current = true;
    try {
      const active = await getActiveHeroSlides();
      setSlides(active);
    } catch (error) {
      console.error('Error loading hero slides:', error);
    } finally {
      setHasLoaded(true);
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
      .channel('flexfits-hero-slides-live')
      .on('postgres_changes', { event: '*', schema: 'public', table: 'hero_slides' }, () => {
        void refresh();
      })
      .subscribe();

    return () => {
      void client.removeChannel(channel);
    };
  }, []);

  useEffect(() => {
    setActiveIndex(0);
  }, [slides.length]);

  useEffect(() => {
    if (slides.length <= 1) return;
    const timer = window.setInterval(() => {
      setActiveIndex((prev) => (prev + 1) % slides.length);
    }, ROTATE_INTERVAL_MS);
    return () => window.clearInterval(timer);
  }, [slides.length]);

  if (!hasLoaded) {
    return <div className="h-screen bg-black" />;
  }

  if (slides.length === 0) {
    return <StaticFallbackHero setView={setView} />;
  }

  return (
    <div className="relative w-full h-screen overflow-hidden">
      <div
        className="flex h-full w-full transition-transform duration-700 ease-out will-change-transform"
        style={{ transform: `translateX(-${activeIndex * 100}%)` }}
      >
        {slides.map((slide) => (
          <HeroSlideContent key={slide.id} slide={slide} />
        ))}
      </div>

      {slides.length > 1 && (
        <div className="absolute bottom-6 left-0 right-0 flex items-center justify-center gap-2 z-20">
          {slides.map((slide, index) => (
            <button
              key={slide.id}
              type="button"
              aria-label={`Go to slide ${index + 1}`}
              onClick={() => setActiveIndex(index)}
              className={`h-1.5 rounded-full transition-all ${index === activeIndex ? 'w-8 bg-white' : 'w-4 bg-white/40'}`}
            />
          ))}
        </div>
      )}
    </div>
  );
}
