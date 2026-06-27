import React, { useEffect, useRef, useState } from 'react';
import { ArrowUp, ArrowDown, Trash2, Plus, Image as ImageIcon, Eye, EyeOff, Upload } from 'lucide-react';
import { Announcement, HeroSlide, HomepageSectionSetting, Tag } from '../types';
import {
  getAnnouncements,
  createAnnouncement,
  updateAnnouncement,
  deleteAnnouncement,
  reorderAnnouncements,
  getHeroSlides,
  createHeroSlide,
  updateHeroSlide,
  deleteHeroSlide,
  reorderHeroSlides,
  getHomepageSectionSettings,
  updateHomepageSectionSetting,
  reorderHomepageSections,
  createHomepageSection,
  deleteHomepageSection,
  getTags,
  uploadThemeImage,
} from '../services/database';

function isValidLinkFormat(url: string): boolean {
  const trimmed = url.trim();
  if (!trimmed) return true;
  if (/^\/[\w./%+-]*$/i.test(trimmed)) return true;
  try {
    const parsed = new URL(trimmed);
    return parsed.protocol === 'http:' || parsed.protocol === 'https:';
  } catch {
    return false;
  }
}

function moveItem<T>(items: T[], index: number, direction: -1 | 1): T[] {
  const targetIndex = index + direction;
  if (targetIndex < 0 || targetIndex >= items.length) return items;
  const next = [...items];
  [next[index], next[targetIndex]] = [next[targetIndex], next[index]];
  return next;
}

function ErrorBanner({ message }: { message: string }) {
  return (
    <div className="bg-red-50 border border-red-200 text-red-700 px-4 py-2.5 rounded-xl text-[11px] font-bold uppercase tracking-wide">
      {message}
    </div>
  );
}

// ==================== ANNOUNCEMENT MANAGER ====================

function AnnouncementManager() {
  const [items, setItems] = useState<Announcement[]>([]);
  const [isLoading, setIsLoading] = useState(true);
  const [error, setError] = useState('');
  const [savingId, setSavingId] = useState<string | null>(null);
  const [newText, setNewText] = useState('');
  const [newLink, setNewLink] = useState('');
  const [isAdding, setIsAdding] = useState(false);
  const [drafts, setDrafts] = useState<Record<string, { text: string; linkUrl: string }>>({});

  const load = async () => {
    setIsLoading(true);
    setError('');
    try {
      const rows = await getAnnouncements();
      setItems(rows);
      setDrafts(Object.fromEntries(rows.map((row) => [row.id, { text: row.text, linkUrl: row.linkUrl || '' }])));
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Failed to load announcements.');
    } finally {
      setIsLoading(false);
    }
  };

  useEffect(() => {
    void load();
  }, []);

  const handleAdd = async () => {
    const text = newText.trim();
    if (!text) {
      setError('Announcement text cannot be empty.');
      return;
    }
    if (!isValidLinkFormat(newLink)) {
      setError('Link must be a full URL (https://...) or a path starting with /.');
      return;
    }
    setError('');
    setIsAdding(true);
    try {
      const created = await createAnnouncement({ text, linkUrl: newLink.trim() || null });
      setItems((prev) => [...prev, created]);
      setDrafts((prev) => ({ ...prev, [created.id]: { text: created.text, linkUrl: created.linkUrl || '' } }));
      setNewText('');
      setNewLink('');
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Failed to add announcement.');
    } finally {
      setIsAdding(false);
    }
  };

  const handleSave = async (id: string) => {
    const draft = drafts[id];
    if (!draft) return;
    const text = draft.text.trim();
    if (!text) {
      setError('Announcement text cannot be empty.');
      return;
    }
    if (!isValidLinkFormat(draft.linkUrl)) {
      setError('Link must be a full URL (https://...) or a path starting with /.');
      return;
    }
    setError('');
    setSavingId(id);
    try {
      await updateAnnouncement(id, { text, linkUrl: draft.linkUrl.trim() || null });
      setItems((prev) => prev.map((row) => row.id === id ? { ...row, text, linkUrl: draft.linkUrl.trim() || null } : row));
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Failed to save announcement.');
    } finally {
      setSavingId(null);
    }
  };

  const handleToggleActive = async (item: Announcement) => {
    setSavingId(item.id);
    setError('');
    try {
      await updateAnnouncement(item.id, { isActive: !item.isActive });
      setItems((prev) => prev.map((row) => row.id === item.id ? { ...row, isActive: !row.isActive } : row));
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Failed to update announcement.');
    } finally {
      setSavingId(null);
    }
  };

  const handleDelete = async (id: string) => {
    if (!window.confirm('Delete this announcement?')) return;
    setSavingId(id);
    setError('');
    try {
      await deleteAnnouncement(id);
      setItems((prev) => prev.filter((row) => row.id !== id));
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Failed to delete announcement.');
    } finally {
      setSavingId(null);
    }
  };

  const handleMove = async (index: number, direction: -1 | 1) => {
    const reordered = moveItem(items, index, direction);
    if (reordered === items) return;
    setItems(reordered);
    setError('');
    try {
      await reorderAnnouncements(reordered.map((row) => row.id));
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Failed to reorder announcements.');
      void load();
    }
  };

  return (
    <div className="bg-white border rounded-2xl p-5 min-w-0">
      <div className="mb-4">
        <h3 className="text-base font-black uppercase text-gray-900">Announcement Bar</h3>
        <p className="text-[11px] text-gray-500 font-semibold mt-0.5">Shown at the very top of the customer-facing site. Multiple active announcements rotate automatically.</p>
      </div>

      {error && <div className="mb-3"><ErrorBanner message={error} /></div>}

      <div className="mb-5 p-3 bg-gray-50 rounded-xl border border-gray-100 space-y-2">
        <input
          type="text"
          placeholder="Announcement text"
          value={newText}
          onChange={(e) => setNewText(e.target.value)}
          className="w-full p-2.5 bg-white border rounded-lg text-sm font-semibold outline-none focus:ring-2 focus:ring-orange-500 min-w-0"
        />
        <input
          type="text"
          placeholder="Optional link (https://... or /shop)"
          value={newLink}
          onChange={(e) => setNewLink(e.target.value)}
          className="w-full p-2.5 bg-white border rounded-lg text-sm font-semibold outline-none focus:ring-2 focus:ring-orange-500 min-w-0"
        />
        <button
          type="button"
          disabled={isAdding}
          onClick={handleAdd}
          className="w-full sm:w-auto inline-flex items-center justify-center gap-1.5 bg-black text-white px-4 py-2.5 rounded-lg font-black uppercase text-[11px] tracking-wider hover:bg-orange-600 transition-all disabled:opacity-50"
        >
          <Plus size={14} /> {isAdding ? 'Adding...' : 'Add Announcement'}
        </button>
      </div>

      {isLoading ? (
        <p className="text-center py-8 text-gray-400 font-bold uppercase text-xs">Loading...</p>
      ) : items.length === 0 ? (
        <p className="text-center py-8 text-gray-300 font-bold uppercase text-xs italic">No announcements yet.</p>
      ) : (
        <div className="space-y-2">
          {items.map((item, index) => {
            const draft = drafts[item.id] || { text: item.text, linkUrl: item.linkUrl || '' };
            const isBusy = savingId === item.id;
            return (
              <div key={item.id} className="border rounded-xl p-3 min-w-0">
                <div className="flex items-start gap-2 min-w-0">
                  <div className="flex-1 min-w-0 space-y-2">
                    <input
                      type="text"
                      value={draft.text}
                      onChange={(e) => setDrafts((prev) => ({ ...prev, [item.id]: { ...draft, text: e.target.value } }))}
                      className="w-full p-2 bg-gray-50 border rounded-lg text-sm font-semibold outline-none focus:ring-2 focus:ring-orange-500 min-w-0"
                    />
                    <input
                      type="text"
                      placeholder="Optional link"
                      value={draft.linkUrl}
                      onChange={(e) => setDrafts((prev) => ({ ...prev, [item.id]: { ...draft, linkUrl: e.target.value } }))}
                      className="w-full p-2 bg-gray-50 border rounded-lg text-xs font-medium outline-none focus:ring-2 focus:ring-orange-500 min-w-0"
                    />
                  </div>
                  <div className="flex flex-col gap-1 flex-shrink-0">
                    <button type="button" disabled={index === 0} onClick={() => handleMove(index, -1)} className="p-1.5 rounded-lg border text-gray-500 hover:bg-gray-50 disabled:opacity-30"><ArrowUp size={13} /></button>
                    <button type="button" disabled={index === items.length - 1} onClick={() => handleMove(index, 1)} className="p-1.5 rounded-lg border text-gray-500 hover:bg-gray-50 disabled:opacity-30"><ArrowDown size={13} /></button>
                  </div>
                </div>
                <div className="flex items-center justify-between gap-2 mt-2.5 flex-wrap">
                  <label className="inline-flex items-center gap-2 cursor-pointer">
                    <input type="checkbox" checked={item.isActive} disabled={isBusy} onChange={() => handleToggleActive(item)} className="accent-orange-600 w-4 h-4" />
                    <span className="text-[10px] font-black uppercase tracking-wider text-gray-600">{item.isActive ? 'Active' : 'Disabled'}</span>
                  </label>
                  <div className="flex items-center gap-2">
                    <button type="button" disabled={isBusy} onClick={() => handleSave(item.id)} className="px-3 py-1.5 rounded-lg bg-gray-900 text-white text-[10px] font-black uppercase tracking-wider hover:bg-orange-600 transition-all disabled:opacity-50">
                      {isBusy ? 'Saving...' : 'Save'}
                    </button>
                    <button type="button" disabled={isBusy} onClick={() => handleDelete(item.id)} className="p-1.5 rounded-lg border border-red-200 text-red-500 hover:bg-red-50 disabled:opacity-50"><Trash2 size={14} /></button>
                  </div>
                </div>
              </div>
            );
          })}
        </div>
      )}
    </div>
  );
}

// ==================== HERO BANNER MANAGER ====================

type HeroSlideDraft = {
  title: string;
  subtitle: string;
  desktopImageUrl: string;
  mobileImageUrl: string;
  buttonText: string;
  buttonLink: string;
};

function emptyHeroDraft(): HeroSlideDraft {
  return { title: '', subtitle: '', desktopImageUrl: '', mobileImageUrl: '', buttonText: '', buttonLink: '' };
}

function heroSlideToDraft(slide: HeroSlide): HeroSlideDraft {
  return {
    title: slide.title || '',
    subtitle: slide.subtitle || '',
    desktopImageUrl: slide.desktopImageUrl || '',
    mobileImageUrl: slide.mobileImageUrl || '',
    buttonText: slide.buttonText || '',
    buttonLink: slide.buttonLink || '',
  };
}

function validateHeroDraft(draft: HeroSlideDraft): string {
  if (!draft.desktopImageUrl.trim()) return 'Desktop image URL is required.';
  if (draft.buttonText.trim() && !draft.buttonLink.trim()) return 'Button link is required when button text is set.';
  if (draft.buttonLink.trim() && !draft.buttonText.trim()) return 'Button text is required when button link is set.';
  return '';
}

function ImageUploadField({
  label,
  hint,
  folder,
  value,
  onChange,
}: {
  label: string;
  hint: string;
  folder: 'hero-desktop' | 'hero-mobile';
  value: string;
  onChange: (url: string) => void;
}) {
  const [isUploading, setIsUploading] = useState(false);
  const [uploadError, setUploadError] = useState('');
  const [previewFailed, setPreviewFailed] = useState(false);
  const inputRef = useRef<HTMLInputElement>(null);
  const trimmedValue = value.trim();

  const handleFileChange = async (e: React.ChangeEvent<HTMLInputElement>) => {
    const file = e.target.files?.[0];
    e.target.value = '';
    if (!file) return;
    setUploadError('');
    setIsUploading(true);
    try {
      const url = await uploadThemeImage(file, folder);
      setPreviewFailed(false);
      onChange(url);
    } catch (err) {
      setUploadError(err instanceof Error ? err.message : 'Upload failed.');
    } finally {
      setIsUploading(false);
    }
  };

  return (
    <div>
      <label className="text-[10px] font-black uppercase tracking-wider text-gray-500">{label}</label>
      <p className="text-[10px] text-gray-400 font-semibold mt-0.5 mb-1.5">{hint}</p>
      <div className="flex items-center gap-2 flex-wrap">
        <button
          type="button"
          disabled={isUploading}
          onClick={() => inputRef.current?.click()}
          className="inline-flex items-center gap-1.5 px-3 py-2 rounded-lg border border-gray-200 bg-white text-[11px] font-black uppercase tracking-wider text-gray-700 hover:border-orange-500 hover:text-orange-600 transition-all disabled:opacity-50"
        >
          <Upload size={13} /> {isUploading ? 'Uploading...' : trimmedValue ? 'Replace Image' : 'Upload Image'}
        </button>
        {trimmedValue && (
          <button type="button" onClick={() => onChange('')} className="text-[10px] font-black uppercase text-red-500 hover:underline">
            Remove
          </button>
        )}
        <input ref={inputRef} type="file" accept="image/jpeg,image/png,image/webp,image/gif" className="hidden" onChange={handleFileChange} />
      </div>
      {uploadError && <p className="text-[10px] text-red-500 font-bold mt-1">{uploadError}</p>}
      {trimmedValue && (
        <div className="mt-1.5 rounded-lg border border-gray-100 bg-gray-50 overflow-hidden h-24 flex items-center justify-center">
          {previewFailed ? (
            <span className="text-[10px] text-gray-400 font-bold uppercase flex items-center gap-1"><ImageIcon size={14} /> Preview unavailable</span>
          ) : (
            <img src={trimmedValue} alt={`${label} preview`} className="max-h-24 max-w-full object-contain" onError={() => setPreviewFailed(true)} onLoad={() => setPreviewFailed(false)} />
          )}
        </div>
      )}
    </div>
  );
}

function HeroSlideForm({
  draft,
  setDraft,
}: {
  draft: HeroSlideDraft;
  setDraft: (next: HeroSlideDraft) => void;
}) {
  return (
    <div className="space-y-2.5">
      <div className="grid grid-cols-1 sm:grid-cols-2 gap-2.5">
        <input type="text" placeholder="Title (optional)" value={draft.title} onChange={(e) => setDraft({ ...draft, title: e.target.value })} className="p-2.5 bg-white border rounded-lg text-sm font-semibold outline-none focus:ring-2 focus:ring-orange-500 min-w-0" />
        <input type="text" placeholder="Subtitle (optional)" value={draft.subtitle} onChange={(e) => setDraft({ ...draft, subtitle: e.target.value })} className="p-2.5 bg-white border rounded-lg text-sm font-semibold outline-none focus:ring-2 focus:ring-orange-500 min-w-0" />
      </div>
      <ImageUploadField
        label="Desktop Image (required)"
        hint="Best fit: 1600×800px, JPG, up to 5MB."
        folder="hero-desktop"
        value={draft.desktopImageUrl}
        onChange={(url) => setDraft({ ...draft, desktopImageUrl: url })}
      />
      <ImageUploadField
        label="Mobile Image (optional — falls back to desktop)"
        hint="Best fit: 400×1000px JPG, up to 5MB."
        folder="hero-mobile"
        value={draft.mobileImageUrl}
        onChange={(url) => setDraft({ ...draft, mobileImageUrl: url })}
      />
      <div className="grid grid-cols-1 sm:grid-cols-2 gap-2.5">
        <input type="text" placeholder="Button text (optional)" value={draft.buttonText} onChange={(e) => setDraft({ ...draft, buttonText: e.target.value })} className="p-2.5 bg-white border rounded-lg text-sm font-semibold outline-none focus:ring-2 focus:ring-orange-500 min-w-0" />
        <input type="text" placeholder="Button link (optional)" value={draft.buttonLink} onChange={(e) => setDraft({ ...draft, buttonLink: e.target.value })} className="p-2.5 bg-white border rounded-lg text-sm font-semibold outline-none focus:ring-2 focus:ring-orange-500 min-w-0" />
      </div>
    </div>
  );
}

function HeroBannerManager() {
  const [items, setItems] = useState<HeroSlide[]>([]);
  const [isLoading, setIsLoading] = useState(true);
  const [error, setError] = useState('');
  const [savingId, setSavingId] = useState<string | null>(null);
  const [newDraft, setNewDraft] = useState<HeroSlideDraft>(emptyHeroDraft());
  const [isAdding, setIsAdding] = useState(false);
  const [drafts, setDrafts] = useState<Record<string, HeroSlideDraft>>({});

  const load = async () => {
    setIsLoading(true);
    setError('');
    try {
      const rows = await getHeroSlides();
      setItems(rows);
      setDrafts(Object.fromEntries(rows.map((row) => [row.id, heroSlideToDraft(row)])));
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Failed to load hero slides.');
    } finally {
      setIsLoading(false);
    }
  };

  useEffect(() => {
    void load();
  }, []);

  const handleAdd = async () => {
    const validationError = validateHeroDraft(newDraft);
    if (validationError) {
      setError(validationError);
      return;
    }
    setError('');
    setIsAdding(true);
    try {
      const created = await createHeroSlide({
        title: newDraft.title.trim() || null,
        subtitle: newDraft.subtitle.trim() || null,
        desktopImageUrl: newDraft.desktopImageUrl.trim(),
        mobileImageUrl: newDraft.mobileImageUrl.trim() || null,
        buttonText: newDraft.buttonText.trim() || null,
        buttonLink: newDraft.buttonLink.trim() || null,
      });
      setItems((prev) => [...prev, created]);
      setDrafts((prev) => ({ ...prev, [created.id]: heroSlideToDraft(created) }));
      setNewDraft(emptyHeroDraft());
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Failed to add hero slide.');
    } finally {
      setIsAdding(false);
    }
  };

  const handleSave = async (id: string) => {
    const draft = drafts[id];
    if (!draft) return;
    const validationError = validateHeroDraft(draft);
    if (validationError) {
      setError(validationError);
      return;
    }
    setError('');
    setSavingId(id);
    try {
      await updateHeroSlide(id, {
        title: draft.title.trim() || null,
        subtitle: draft.subtitle.trim() || null,
        desktopImageUrl: draft.desktopImageUrl.trim(),
        mobileImageUrl: draft.mobileImageUrl.trim() || null,
        buttonText: draft.buttonText.trim() || null,
        buttonLink: draft.buttonLink.trim() || null,
      });
      setItems((prev) => prev.map((row) => row.id === id ? {
        ...row,
        title: draft.title.trim() || null,
        subtitle: draft.subtitle.trim() || null,
        desktopImageUrl: draft.desktopImageUrl.trim(),
        mobileImageUrl: draft.mobileImageUrl.trim() || null,
        buttonText: draft.buttonText.trim() || null,
        buttonLink: draft.buttonLink.trim() || null,
      } : row));
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Failed to save hero slide.');
    } finally {
      setSavingId(null);
    }
  };

  const handleToggleActive = async (item: HeroSlide) => {
    setSavingId(item.id);
    setError('');
    try {
      await updateHeroSlide(item.id, { isActive: !item.isActive });
      setItems((prev) => prev.map((row) => row.id === item.id ? { ...row, isActive: !row.isActive } : row));
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Failed to update hero slide.');
    } finally {
      setSavingId(null);
    }
  };

  const handleDelete = async (id: string) => {
    if (!window.confirm('Delete this hero slide?')) return;
    setSavingId(id);
    setError('');
    try {
      await deleteHeroSlide(id);
      setItems((prev) => prev.filter((row) => row.id !== id));
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Failed to delete hero slide.');
    } finally {
      setSavingId(null);
    }
  };

  const handleMove = async (index: number, direction: -1 | 1) => {
    const reordered = moveItem(items, index, direction);
    if (reordered === items) return;
    setItems(reordered);
    setError('');
    try {
      await reorderHeroSlides(reordered.map((row) => row.id));
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Failed to reorder hero slides.');
      void load();
    }
  };

  return (
    <div className="bg-white border rounded-2xl p-5 min-w-0">
      <div className="mb-4">
        <h3 className="text-base font-black uppercase text-gray-900">Hero Banner Slideshow</h3>
        <p className="text-[11px] text-gray-500 font-semibold mt-0.5">Shown at the top of the homepage. Add multiple active slides to auto-rotate.</p>
      </div>

      {error && <div className="mb-3"><ErrorBanner message={error} /></div>}

      <div className="mb-5 p-3 bg-gray-50 rounded-xl border border-gray-100 space-y-2.5">
        <HeroSlideForm draft={newDraft} setDraft={setNewDraft} />
        <button
          type="button"
          disabled={isAdding}
          onClick={handleAdd}
          className="w-full sm:w-auto inline-flex items-center justify-center gap-1.5 bg-black text-white px-4 py-2.5 rounded-lg font-black uppercase text-[11px] tracking-wider hover:bg-orange-600 transition-all disabled:opacity-50"
        >
          <Plus size={14} /> {isAdding ? 'Adding...' : 'Add Hero Slide'}
        </button>
      </div>

      {isLoading ? (
        <p className="text-center py-8 text-gray-400 font-bold uppercase text-xs">Loading...</p>
      ) : items.length === 0 ? (
        <p className="text-center py-8 text-gray-300 font-bold uppercase text-xs italic">No hero slides yet — homepage shows the default banner.</p>
      ) : (
        <div className="space-y-3">
          {items.map((item, index) => {
            const draft = drafts[item.id] || heroSlideToDraft(item);
            const isBusy = savingId === item.id;
            return (
              <div key={item.id} className="border rounded-xl p-3 min-w-0">
                <div className="flex items-start gap-2 min-w-0">
                  <div className="flex-1 min-w-0">
                    <HeroSlideForm draft={draft} setDraft={(next) => setDrafts((prev) => ({ ...prev, [item.id]: next }))} />
                  </div>
                  <div className="flex flex-col gap-1 flex-shrink-0">
                    <button type="button" disabled={index === 0} onClick={() => handleMove(index, -1)} className="p-1.5 rounded-lg border text-gray-500 hover:bg-gray-50 disabled:opacity-30"><ArrowUp size={13} /></button>
                    <button type="button" disabled={index === items.length - 1} onClick={() => handleMove(index, 1)} className="p-1.5 rounded-lg border text-gray-500 hover:bg-gray-50 disabled:opacity-30"><ArrowDown size={13} /></button>
                  </div>
                </div>
                <div className="flex items-center justify-between gap-2 mt-2.5 flex-wrap">
                  <label className="inline-flex items-center gap-2 cursor-pointer">
                    <input type="checkbox" checked={item.isActive} disabled={isBusy} onChange={() => handleToggleActive(item)} className="accent-orange-600 w-4 h-4" />
                    <span className="text-[10px] font-black uppercase tracking-wider text-gray-600">{item.isActive ? 'Active' : 'Disabled'}</span>
                  </label>
                  <div className="flex items-center gap-2">
                    <button type="button" disabled={isBusy} onClick={() => handleSave(item.id)} className="px-3 py-1.5 rounded-lg bg-gray-900 text-white text-[10px] font-black uppercase tracking-wider hover:bg-orange-600 transition-all disabled:opacity-50">
                      {isBusy ? 'Saving...' : 'Save'}
                    </button>
                    <button type="button" disabled={isBusy} onClick={() => handleDelete(item.id)} className="p-1.5 rounded-lg border border-red-200 text-red-500 hover:bg-red-50 disabled:opacity-50"><Trash2 size={14} /></button>
                  </div>
                </div>
              </div>
            );
          })}
        </div>
      )}
    </div>
  );
}

// ==================== HOMEPAGE SECTIONS MANAGER ====================

function HomepageSectionsManager() {
  const [items, setItems] = useState<HomepageSectionSetting[]>([]);
  const [tags, setTags] = useState<Tag[]>([]);
  const [isLoading, setIsLoading] = useState(true);
  const [error, setError] = useState('');
  const [savingId, setSavingId] = useState<string | null>(null);
  const [drafts, setDrafts] = useState<Record<string, { title: string; subtitle: string; tagId: string }>>({});
  const [newTitle, setNewTitle] = useState('');
  const [newSubtitle, setNewSubtitle] = useState('');
  const [newTagId, setNewTagId] = useState('');
  const [isAdding, setIsAdding] = useState(false);

  const load = async () => {
    setIsLoading(true);
    setError('');
    try {
      const [rows, tagRows] = await Promise.all([getHomepageSectionSettings(), getTags()]);
      setItems(rows);
      setTags(tagRows);
      setDrafts(Object.fromEntries(rows.map((row) => [row.id, { title: row.title, subtitle: row.subtitle || '', tagId: row.tagId || '' }])));
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Failed to load homepage sections.');
    } finally {
      setIsLoading(false);
    }
  };

  useEffect(() => {
    void load();
  }, []);

  const handleAdd = async () => {
    const title = newTitle.trim();
    if (!title) {
      setError('Section title cannot be empty.');
      return;
    }
    if (!newTagId) {
      setError('Select a tag for the new section.');
      return;
    }
    setError('');
    setIsAdding(true);
    try {
      const created = await createHomepageSection({ title, subtitle: newSubtitle.trim() || null, tagId: newTagId });
      setItems((prev) => [...prev, created]);
      setDrafts((prev) => ({ ...prev, [created.id]: { title: created.title, subtitle: created.subtitle || '', tagId: created.tagId || '' } }));
      setNewTitle('');
      setNewSubtitle('');
      setNewTagId('');
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Failed to create section.');
    } finally {
      setIsAdding(false);
    }
  };

  const handleSave = async (id: string) => {
    const draft = drafts[id];
    if (!draft) return;
    const title = draft.title.trim();
    if (!title) {
      setError('Section title cannot be empty.');
      return;
    }
    setError('');
    setSavingId(id);
    try {
      await updateHomepageSectionSetting(id, { title, subtitle: draft.subtitle.trim() || null, tagId: draft.tagId || null });
      setItems((prev) => prev.map((row) => row.id === id ? { ...row, title, subtitle: draft.subtitle.trim() || null, tagId: draft.tagId || null } : row));
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Failed to save section.');
    } finally {
      setSavingId(null);
    }
  };

  const handleToggleVisible = async (item: HomepageSectionSetting) => {
    setSavingId(item.id);
    setError('');
    try {
      await updateHomepageSectionSetting(item.id, { isVisible: !item.isVisible });
      setItems((prev) => prev.map((row) => row.id === item.id ? { ...row, isVisible: !row.isVisible } : row));
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Failed to update section.');
    } finally {
      setSavingId(null);
    }
  };

  const handleDelete = async (item: HomepageSectionSetting) => {
    if (!window.confirm(`Delete the "${item.title}" section?`)) return;
    setSavingId(item.id);
    setError('');
    try {
      await deleteHomepageSection(item.id);
      setItems((prev) => prev.filter((row) => row.id !== item.id));
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Failed to delete section.');
    } finally {
      setSavingId(null);
    }
  };

  const handleMove = async (index: number, direction: -1 | 1) => {
    const reordered = moveItem(items, index, direction);
    if (reordered === items) return;
    setItems(reordered);
    setError('');
    try {
      await reorderHomepageSections(reordered.map((row) => row.id));
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Failed to reorder sections.');
      void load();
    }
  };

  return (
    <div className="bg-white border rounded-2xl p-5 min-w-0">
      <div className="mb-4">
        <h3 className="text-base font-black uppercase text-gray-900">Homepage Sections</h3>
        <p className="text-[11px] text-gray-500 font-semibold mt-0.5">
          Visible sections appear on the homepage, in this order. Link a section to a tag (managed in Admin "Tags") to
          automatically show every product carrying that tag.
        </p>
      </div>

      {error && <div className="mb-3"><ErrorBanner message={error} /></div>}

      <div className="mb-5 p-3 bg-gray-50 rounded-xl border border-gray-100 space-y-2">
        <input
          type="text"
          placeholder="Section title, e.g. 50% Off Picks"
          value={newTitle}
          onChange={(e) => setNewTitle(e.target.value)}
          className="w-full p-2.5 bg-white border rounded-lg text-sm font-semibold outline-none focus:ring-2 focus:ring-orange-500 min-w-0"
        />
        <input
          type="text"
          placeholder="Optional subtitle"
          value={newSubtitle}
          onChange={(e) => setNewSubtitle(e.target.value)}
          className="w-full p-2.5 bg-white border rounded-lg text-sm font-semibold outline-none focus:ring-2 focus:ring-orange-500 min-w-0"
        />
        <select
          value={newTagId}
          onChange={(e) => setNewTagId(e.target.value)}
          className="w-full p-2.5 bg-white border rounded-lg text-sm font-semibold outline-none focus:ring-2 focus:ring-orange-500 min-w-0"
        >
          <option value="">Select a tag...</option>
          {tags.map((tag) => <option key={tag.id} value={tag.id}>{tag.name}</option>)}
        </select>
        {tags.length === 0 && (
          <p className="text-[10px] text-gray-400 font-semibold">No tags yet — create one in the Admin "Tags" section first.</p>
        )}
        <button
          type="button"
          disabled={isAdding}
          onClick={() => void handleAdd()}
          className="w-full sm:w-auto inline-flex items-center justify-center gap-1.5 bg-black text-white px-4 py-2.5 rounded-lg font-black uppercase text-[11px] tracking-wider hover:bg-orange-600 transition-all disabled:opacity-50"
        >
          <Plus size={14} /> {isAdding ? 'Adding...' : 'Add Section From Tag'}
        </button>
      </div>

      {isLoading ? (
        <p className="text-center py-8 text-gray-400 font-bold uppercase text-xs">Loading...</p>
      ) : (
        <div className="space-y-2">
          {items.map((item, index) => {
            const draft = drafts[item.id] || { title: item.title, subtitle: item.subtitle || '', tagId: item.tagId || '' };
            const isBusy = savingId === item.id;
            return (
              <div key={item.id} className="border rounded-xl p-3 min-w-0">
                <div className="flex items-start gap-2 min-w-0">
                  <div className="flex-1 min-w-0 space-y-2">
                    <input
                      type="text"
                      value={draft.title}
                      onChange={(e) => setDrafts((prev) => ({ ...prev, [item.id]: { ...draft, title: e.target.value } }))}
                      className="w-full p-2 bg-gray-50 border rounded-lg text-sm font-semibold outline-none focus:ring-2 focus:ring-orange-500 min-w-0"
                    />
                    <input
                      type="text"
                      placeholder="Optional subtitle"
                      value={draft.subtitle}
                      onChange={(e) => setDrafts((prev) => ({ ...prev, [item.id]: { ...draft, subtitle: e.target.value } }))}
                      className="w-full p-2 bg-gray-50 border rounded-lg text-xs font-medium outline-none focus:ring-2 focus:ring-orange-500 min-w-0"
                    />
                    <select
                      value={draft.tagId}
                      onChange={(e) => setDrafts((prev) => ({ ...prev, [item.id]: { ...draft, tagId: e.target.value } }))}
                      className="w-full p-2 bg-gray-50 border rounded-lg text-xs font-bold outline-none focus:ring-2 focus:ring-orange-500 min-w-0"
                    >
                      <option value="">No tag (built-in section behavior)</option>
                      {tags.map((tag) => <option key={tag.id} value={tag.id}>{tag.name}</option>)}
                    </select>
                  </div>
                  <div className="flex flex-col gap-1 flex-shrink-0">
                    <button type="button" disabled={index === 0} onClick={() => handleMove(index, -1)} className="p-1.5 rounded-lg border text-gray-500 hover:bg-gray-50 disabled:opacity-30"><ArrowUp size={13} /></button>
                    <button type="button" disabled={index === items.length - 1} onClick={() => handleMove(index, 1)} className="p-1.5 rounded-lg border text-gray-500 hover:bg-gray-50 disabled:opacity-30"><ArrowDown size={13} /></button>
                  </div>
                </div>
                <div className="flex items-center justify-between gap-2 mt-2.5 flex-wrap">
                  <button type="button" disabled={isBusy} onClick={() => handleToggleVisible(item)} className="inline-flex items-center gap-1.5 text-[10px] font-black uppercase tracking-wider text-gray-600">
                    {item.isVisible ? <Eye size={14} className="text-green-600" /> : <EyeOff size={14} className="text-gray-400" />}
                    {item.isVisible ? 'Visible' : 'Hidden'}
                  </button>
                  <div className="flex items-center gap-2">
                    <button type="button" disabled={isBusy} onClick={() => handleSave(item.id)} className="px-3 py-1.5 rounded-lg bg-gray-900 text-white text-[10px] font-black uppercase tracking-wider hover:bg-orange-600 transition-all disabled:opacity-50">
                      {isBusy ? 'Saving...' : 'Save'}
                    </button>
                    <button type="button" disabled={isBusy} onClick={() => handleDelete(item)} className="p-1.5 rounded-lg border border-red-200 text-red-500 hover:bg-red-50 disabled:opacity-50"><Trash2 size={14} /></button>
                  </div>
                </div>
              </div>
            );
          })}
        </div>
      )}
    </div>
  );
}

// ==================== EDIT THEME PANEL ====================

export default function EditThemePanel() {
  return (
    <div className="space-y-6 min-w-0 max-w-full overflow-x-hidden animate-fade-in-up">
      <div>
        <p className="text-[10px] font-bold uppercase text-gray-500 mb-1">Admin Dashboard</p>
        <h2 className="text-lg font-black uppercase text-gray-900">Edit Theme</h2>
        <p className="text-xs text-gray-500 font-medium mt-1">Manage the announcement bar, hero banner slideshow, and homepage sections shown to customers. Changes save to the database and persist after refresh.</p>
      </div>
      <AnnouncementManager />
      <HeroBannerManager />
      <HomepageSectionsManager />
    </div>
  );
}
