import React, { useEffect, useState } from 'react';
import { Plus, Trash2, Tag as TagIcon } from 'lucide-react';
import { Tag } from '../types';
import { getTags, createTag, updateTag, deleteTag } from '../services/database';

function ErrorBanner({ message }: { message: string }) {
  return (
    <div className="bg-red-50 border border-red-200 text-red-700 px-4 py-2.5 rounded-xl text-[11px] font-bold uppercase tracking-wide">
      {message}
    </div>
  );
}

export default function TagsManagerPanel() {
  const [tags, setTags] = useState<Tag[]>([]);
  const [isLoading, setIsLoading] = useState(true);
  const [error, setError] = useState('');
  const [newName, setNewName] = useState('');
  const [isAdding, setIsAdding] = useState(false);
  const [savingId, setSavingId] = useState<string | null>(null);
  const [drafts, setDrafts] = useState<Record<string, string>>({});

  const load = async () => {
    setIsLoading(true);
    setError('');
    try {
      const rows = await getTags();
      setTags(rows);
      setDrafts(Object.fromEntries(rows.map((row) => [row.id, row.name])));
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Failed to load tags.');
    } finally {
      setIsLoading(false);
    }
  };

  useEffect(() => {
    void load();
  }, []);

  const handleAdd = async () => {
    const name = newName.trim();
    if (!name) {
      setError('Tag name cannot be empty.');
      return;
    }
    setError('');
    setIsAdding(true);
    try {
      const created = await createTag(name);
      setTags((prev) => [...prev, created].sort((a, b) => a.name.localeCompare(b.name, undefined, { sensitivity: 'base' })));
      setDrafts((prev) => ({ ...prev, [created.id]: created.name }));
      setNewName('');
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Failed to create tag.');
    } finally {
      setIsAdding(false);
    }
  };

  const handleSave = async (id: string) => {
    const draft = drafts[id];
    const name = String(draft || '').trim();
    if (!name) {
      setError('Tag name cannot be empty.');
      return;
    }
    setError('');
    setSavingId(id);
    try {
      await updateTag(id, name);
      setTags((prev) => prev.map((row) => row.id === id ? { ...row, name } : row).sort((a, b) => a.name.localeCompare(b.name, undefined, { sensitivity: 'base' })));
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Failed to save tag.');
    } finally {
      setSavingId(null);
    }
  };

  const handleDelete = async (tag: Tag) => {
    if (!window.confirm(`Delete tag "${tag.name}"? It will be removed from every product and any homepage section using it.`)) return;
    setSavingId(tag.id);
    setError('');
    try {
      await deleteTag(tag.id);
      setTags((prev) => prev.filter((row) => row.id !== tag.id));
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Failed to delete tag.');
    } finally {
      setSavingId(null);
    }
  };

  return (
    <div className="min-w-0 max-w-full overflow-x-hidden animate-fade-in-up">
      <div className="max-w-2xl space-y-6 min-w-0">
        <div>
          <p className="text-[10px] font-bold uppercase text-gray-500 mb-1">Admin Dashboard</p>
          <h2 className="text-lg font-black uppercase text-gray-900">Tags</h2>
          <p className="text-xs text-gray-500 font-medium mt-1">
            Group products by tag (e.g. <span className="font-bold">D50</span>), then link a tag to a Homepage Section
            in Edit Theme to automatically show every tagged product there.
          </p>
        </div>

        {error && <ErrorBanner message={error} />}

        <div className="bg-white border rounded-2xl p-5 min-w-0">
          <div className="flex flex-col sm:flex-row gap-2">
            <input
              type="text"
              placeholder="New tag name, e.g. D50"
              value={newName}
              onChange={(e) => setNewName(e.target.value)}
              onKeyDown={(e) => { if (e.key === 'Enter') void handleAdd(); }}
              className="flex-1 p-2.5 bg-gray-50 border rounded-lg text-sm font-semibold outline-none focus:ring-2 focus:ring-orange-500 min-w-0"
            />
            <button
              type="button"
              disabled={isAdding}
              onClick={() => void handleAdd()}
              className="inline-flex items-center justify-center gap-1.5 bg-black text-white px-4 py-2.5 rounded-lg font-black uppercase text-[11px] tracking-wider hover:bg-orange-600 transition-all disabled:opacity-50"
            >
              <Plus size={14} /> {isAdding ? 'Adding...' : 'Add Tag'}
            </button>
          </div>
        </div>

        <div className="bg-white border rounded-2xl overflow-hidden min-w-0">
          {isLoading ? (
            <p className="text-center py-8 text-gray-400 font-bold uppercase text-xs">Loading...</p>
          ) : tags.length === 0 ? (
            <p className="text-center py-8 text-gray-300 font-bold uppercase text-xs italic">No tags yet.</p>
          ) : (
            <div className="divide-y">
              {tags.map((tag) => {
                const isBusy = savingId === tag.id;
                return (
                  <div key={tag.id} className="p-3 flex items-center gap-2 min-w-0">
                    <TagIcon size={14} className="text-gray-300 flex-shrink-0" />
                    <input
                      type="text"
                      value={drafts[tag.id] ?? tag.name}
                      onChange={(e) => setDrafts((prev) => ({ ...prev, [tag.id]: e.target.value }))}
                      className="flex-1 p-2 bg-gray-50 border rounded-lg text-sm font-semibold outline-none focus:ring-2 focus:ring-orange-500 min-w-0"
                    />
                    <button
                      type="button"
                      disabled={isBusy || drafts[tag.id] === tag.name}
                      onClick={() => handleSave(tag.id)}
                      className="px-3 py-2 rounded-lg bg-gray-900 text-white text-[10px] font-black uppercase tracking-wider hover:bg-orange-600 transition-all disabled:opacity-40 flex-shrink-0"
                    >
                      {isBusy ? 'Saving...' : 'Save'}
                    </button>
                    <button
                      type="button"
                      disabled={isBusy}
                      onClick={() => handleDelete(tag)}
                      className="p-2 rounded-lg border border-red-200 text-red-500 hover:bg-red-50 disabled:opacity-50 flex-shrink-0"
                    >
                      <Trash2 size={14} />
                    </button>
                  </div>
                );
              })}
            </div>
          )}
        </div>
      </div>
    </div>
  );
}

