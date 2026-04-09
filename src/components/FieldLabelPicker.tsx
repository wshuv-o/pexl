import { useState } from 'react';
import { getFieldLabelsForType, type FieldLabel, type DocumentType } from '@/types/utilscraper';
import { Input } from '@/components/ui/input';
import { Button } from '@/components/ui/button';

interface Props {
  x: number;
  y: number;
  docType: DocumentType;
  customFields: string[];        // user-added custom field names
  onSelect: (field: FieldLabel, customLabel?: string) => void;
  onCancel: () => void;
}

export default function FieldLabelPicker({ x, y, docType, customFields, onSelect, onCancel }: Props) {
  const [showCustom, setShowCustom] = useState(false);
  const [customLabel, setCustomLabel] = useState('');

  const labels = getFieldLabelsForType(docType).filter(f => f.value !== 'custom');

  const submitCustom = () => {
    if (customLabel.trim()) onSelect('custom', customLabel.trim());
  };

  return (
    <div
      className="absolute z-20 bg-card border border-border rounded-lg shadow-lg p-2 w-48"
      style={{ left: Math.min(x, 200), top: y }}
      onClick={e => e.stopPropagation()}
      onMouseDown={e => e.stopPropagation()}
    >
      <p className="text-xs font-semibold text-muted-foreground px-2 py-1">Label this field:</p>
      <div className={(labels.length + customFields.length) > 5 ? 'max-h-[220px] overflow-y-auto custom-scrollbar' : ''}>
        {labels.map(f => (
          <button
            key={f.value}
            className="w-full text-left px-2 py-1.5 text-sm rounded hover:bg-muted flex items-center gap-2"
            onClick={() => onSelect(f.value)}
          >
            <span className="w-2.5 h-2.5 rounded-full" style={{ backgroundColor: f.color }} />
            {f.label}
          </button>
        ))}
        {customFields.length > 0 && (
          <div className="border-t border-border my-1" />
        )}
        {customFields.map(name => (
          <button
            key={`custom-${name}`}
            className="w-full text-left px-2 py-1.5 text-sm rounded hover:bg-muted flex items-center gap-2"
            onClick={() => onSelect('custom', name)}
          >
            <span className="w-2.5 h-2.5 rounded-full bg-muted-foreground" />
            <span className="truncate italic">{name}</span>
          </button>
        ))}
      </div>
      {!showCustom ? (
        <button
          className="w-full text-left px-2 py-1.5 text-sm rounded hover:bg-muted text-muted-foreground"
          onClick={() => setShowCustom(true)}
        >
          Custom...
        </button>
      ) : (
        <div className="px-2 py-1 flex gap-1">
          <Input
            className="h-7 text-xs flex-1"
            placeholder="Field name..."
            autoFocus
            value={customLabel}
            onChange={e => setCustomLabel(e.target.value)}
            onKeyDown={e => {
              if (e.key === 'Enter') submitCustom();
              if (e.key === 'Escape') onCancel();
            }}
          />
          <Button
            size="sm"
            className="h-7 px-2 text-xs bg-green-600 hover:bg-green-700 text-white"
            disabled={!customLabel.trim()}
            onClick={submitCustom}
          >
            Add
          </Button>
        </div>
      )}
    </div>
  );
}
