import { useState } from 'react';
import { Check, Download, X } from 'lucide-react';
import {
  Dialog, DialogContent, DialogHeader, DialogTitle, DialogDescription, DialogFooter,
} from '@/components/ui/dialog';

export interface UtilityMergeChoice {
  property: boolean;
  provider: boolean;
  account: boolean;
}

interface Props {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  onConfirm: (choice: UtilityMergeChoice) => void;
}

// Pre-export options for utility-bill exports. Merging by a field collapses
// rows that share the same value into a single row in the pivot table.
export default function UtilityMergeDialog({ open, onOpenChange, onConfirm }: Props) {
  const [choice, setChoice] = useState<UtilityMergeChoice>({
    property: false,
    provider: false,
    account: true,
  });

  const toggle = (key: keyof UtilityMergeChoice) =>
    setChoice(c => ({ ...c, [key]: !c[key] }));

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="max-w-md">
        <DialogHeader>
          <DialogTitle>Export options</DialogTitle>
          <DialogDescription>
            Visually merge label cells in Excel — adjacent rows with the same value get joined into one cell. Data rows stay separate; this is just cosmetic cell-merging.
          </DialogDescription>
        </DialogHeader>

        <div className="space-y-2">
          <Row
            label="Property Name"
            description="Merge adjacent cells with the same property"
            checked={choice.property}
            onToggle={() => toggle('property')}
          />
          <Row
            label="Provider Name"
            description="Merge adjacent cells with the same provider"
            checked={choice.provider}
            onToggle={() => toggle('provider')}
          />
          <Row
            label="Account Number"
            description="Merge adjacent cells with the same account number"
            checked={choice.account}
            onToggle={() => toggle('account')}
          />
        </div>

        <DialogFooter className="flex items-center justify-end gap-2">
          <button
            onClick={() => onOpenChange(false)}
            className="px-3 py-1.5 rounded-md text-xs text-muted-foreground hover:bg-muted transition-colors"
          >
            <X className="w-3.5 h-3.5 inline mr-1" />
            Cancel
          </button>
          <button
            onClick={() => onConfirm(choice)}
            className="flex items-center gap-1.5 px-4 py-1.5 rounded-md bg-primary text-primary-foreground text-xs hover:opacity-90 transition-opacity"
          >
            <Download className="w-3.5 h-3.5" /> Export
          </button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

function Row({
  label, description, checked, onToggle,
}: { label: string; description: string; checked: boolean; onToggle: () => void }) {
  return (
    <label
      className={`flex items-start gap-3 px-3 py-2 rounded-md border cursor-pointer transition-colors
        ${checked
          ? 'bg-primary/10 border-primary/30'
          : 'bg-muted/30 border-border hover:bg-muted/60'}`}
    >
      <input
        type="checkbox"
        checked={checked}
        onChange={onToggle}
        className="sr-only"
      />
      <span
        className={`mt-0.5 w-4 h-4 rounded border flex items-center justify-center shrink-0 ${
          checked ? 'bg-primary border-primary' : 'border-border'
        }`}
      >
        {checked && <Check className="w-3 h-3 text-primary-foreground" />}
      </span>
      <span className="flex-1 min-w-0">
        <span className="block text-sm font-medium text-foreground">{label}</span>
        <span className="block text-xs text-muted-foreground">{description}</span>
      </span>
    </label>
  );
}
