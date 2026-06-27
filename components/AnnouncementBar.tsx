import React, { useEffect, useRef, useState } from 'react';
import { X, ChevronLeft, ChevronRight } from 'lucide-react';
import { Announcement } from '../types';
import { getActiveAnnouncements } from '../services/database';
import { supabase } from '../services/supabase';

const ROTATE_INTERVAL_MS = 5000;

function isExternalLink(url: string): boolean {
  return /^https?:\/\//i.test(url);
}

function AnnouncementContent({ announcement }: { announcement: Announcement }) {
  const linkUrl = String(announcement.linkUrl || '').trim();
  const text = (
    <p className="text-[11px] sm:text-xs font-bold uppercase tracking-wide truncate text-center">
      {announcement.text}
    </p>
  );

  return linkUrl ? (
    <a
      href={linkUrl}
      target={isExternalLink(linkUrl) ? '_blank' : undefined}
      rel={isExternalLink(linkUrl) ? 'noreferrer' : undefined}
      className="hover:text-orange-400 transition-colors min-w-0 max-w-full"
    >
      {text}
    </a>
  ) : (
    <div className="min-w-0 max-w-full">{text}</div>
  );
}

export default function AnnouncementBar() {
  const [announcements, setAnnouncements] = useState<Announcement[]>([]);
  const [activeIndex, setActiveIndex] = useState(0);
  const [isDismissed, setIsDismissed] = useState(false);
  const fetchInFlightRef = useRef(false);
  const autoRotateTimerRef = useRef<number | null>(null);

  const refresh = async () => {
    if (fetchInFlightRef.current) return;
    fetchInFlightRef.current = true;
    try {
      const active = await getActiveAnnouncements();
      setAnnouncements(active);
    } catch (error) {
      console.error('Error loading announcements:', error);
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
      .channel('flexfits-announcements-live')
      .on('postgres_changes', { event: '*', schema: 'public', table: 'announcements' }, () => {
        void refresh();
      })
      .subscribe();

    return () => {
      void client.removeChannel(channel);
    };
  }, []);

  useEffect(() => {
    setActiveIndex(0);
  }, [announcements.length]);

  const canNavigate = announcements.length > 1;

  const startAutoRotate = () => {
    if (autoRotateTimerRef.current) {
      window.clearInterval(autoRotateTimerRef.current);
      autoRotateTimerRef.current = null;
    }
    if (!canNavigate) return;
    autoRotateTimerRef.current = window.setInterval(() => {
      setActiveIndex((prev) => (prev + 1) % announcements.length);
    }, ROTATE_INTERVAL_MS);
  };

  useEffect(() => {
    startAutoRotate();
    return () => {
      if (autoRotateTimerRef.current) window.clearInterval(autoRotateTimerRef.current);
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [announcements.length]);

  const goToIndex = (index: number) => {
    setActiveIndex(index);
    startAutoRotate();
  };

  const goPrev = () => {
    if (!canNavigate) return;
    goToIndex((activeIndex - 1 + announcements.length) % announcements.length);
  };

  const goNext = () => {
    if (!canNavigate) return;
    goToIndex((activeIndex + 1) % announcements.length);
  };

  if (isDismissed || announcements.length === 0) return null;

  return (
    <div className="relative w-full max-w-full overflow-hidden bg-black text-white">
      <div className="max-w-7xl mx-auto px-8 sm:px-10 py-2 flex items-center justify-center gap-1.5 sm:gap-3 min-w-0">
        {canNavigate && (
          <button
            type="button"
            onClick={goPrev}
            aria-label="Previous announcement"
            className="flex-shrink-0 p-1 text-white/60 hover:text-white transition-colors"
          >
            <ChevronLeft size={16} />
          </button>
        )}

        <div className="flex-1 min-w-0 overflow-hidden">
          <div
            className="flex transition-transform duration-500 ease-out"
            style={{ transform: `translateX(-${activeIndex * 100}%)` }}
          >
            {announcements.map((announcement) => (
              <div key={announcement.id} className="w-full flex-shrink-0 flex items-center justify-center min-w-0">
                <AnnouncementContent announcement={announcement} />
              </div>
            ))}
          </div>
        </div>

        {canNavigate && (
          <button
            type="button"
            onClick={goNext}
            aria-label="Next announcement"
            className="flex-shrink-0 p-1 text-white/60 hover:text-white transition-colors"
          >
            <ChevronRight size={16} />
          </button>
        )}
      </div>
      <button
        type="button"
        onClick={() => setIsDismissed(true)}
        aria-label="Dismiss announcement"
        className="absolute right-2 top-1/2 -translate-y-1/2 p-1 text-white/60 hover:text-white transition-colors"
      >
        <X size={14} />
      </button>
    </div>
  );
}
