/**
 * Accent Selector Component
 * Only appears on Chrome browsers - Edge uses natural language detection
 */

import { Globe, Info } from 'lucide-react';
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '@/components/ui/select';
import {
  Tooltip,
  TooltipContent,
  TooltipProvider,
  TooltipTrigger,
} from '@/components/ui/tooltip';
import { Badge } from '@/components/ui/badge';
import { detectBrowser, ACCENT_OPTIONS, AccentCode, getStoredAccent, setStoredAccent } from '@/lib/speechRecognition';
import { useEffect, useState } from 'react';

interface AccentSelectorProps {
  value: string;
  onChange: (accent: string) => void;
  showLabel?: boolean;
  className?: string;
}

export function AccentSelector({ value, onChange, showLabel = true, className = '' }: AccentSelectorProps) {
  const [browser] = useState(() => detectBrowser());
  
  // Load stored accent on mount
  useEffect(() => {
    const stored = getStoredAccent();
    if (stored && stored !== value) {
      onChange(stored);
    }
  }, []);
  
  // Don't render on Edge - it uses natural language detection
  if (browser.isEdge) {
    return null;
  }
  
  const handleChange = (newAccent: string) => {
    setStoredAccent(newAccent);
    onChange(newAccent);
  };
  
  return (
    <div className={`space-y-2 ${className}`}>
      {showLabel && (
        <div className="flex items-center gap-2">
          <Globe className="w-4 h-4 text-muted-foreground" />
          <span className="text-sm font-medium text-foreground">Speech Recognition Accent</span>
          <TooltipProvider>
            <Tooltip>
              <TooltipTrigger asChild>
                <Info className="w-3.5 h-3.5 text-muted-foreground cursor-help" />
              </TooltipTrigger>
              <TooltipContent side="top" className="max-w-xs">
                <p className="text-xs">
                  Chrome requires accent selection for stable speech recognition. 
                  Choose the accent closest to yours for ~30% better accuracy.
                </p>
              </TooltipContent>
            </Tooltip>
          </TooltipProvider>
        </div>
      )}
      
      <div className="flex items-center gap-2">
        <Select value={value} onValueChange={handleChange}>
          <SelectTrigger className="w-full bg-background">
            <SelectValue placeholder="Select your accent" />
          </SelectTrigger>
          <SelectContent className="bg-popover z-50">
            {ACCENT_OPTIONS.map((accent) => (
              <SelectItem key={accent.value} value={accent.value}>
                {accent.label}
              </SelectItem>
            ))}
          </SelectContent>
        </Select>
        
        {browser.isChrome && (
          <Badge variant="outline" className="text-xs whitespace-nowrap">
            Chrome
          </Badge>
        )}
      </div>
    </div>
  );
}

/**
 * Browser Info Badge Component
 * Shows which browser mode is being used for speech recognition
 */
export function BrowserSpeechModeBadge() {
  const [browser] = useState(() => detectBrowser());
  
  if (browser.isEdge) {
    return (
      <TooltipProvider>
        <Tooltip>
          <TooltipTrigger asChild>
            <Badge variant="secondary" className="text-xs gap-1">
              <span className="w-2 h-2 bg-green-500 rounded-full" />
              Edge Natural Mode
            </Badge>
          </TooltipTrigger>
          <TooltipContent side="bottom" className="max-w-xs">
            <p className="text-xs">
              Edge uses natural speech optimization that preserves pauses and fillers 
              for accurate fluency scoring.
            </p>
          </TooltipContent>
        </Tooltip>
      </TooltipProvider>
    );
  }
  
  if (browser.isChrome) {
    return (
      <TooltipProvider>
        <Tooltip>
          <TooltipTrigger asChild>
            <Badge variant="outline" className="text-xs gap-1">
              <span className="w-2 h-2 bg-blue-500 rounded-full" />
              Chrome Accent Mode
            </Badge>
          </TooltipTrigger>
          <TooltipContent side="bottom" className="max-w-xs">
            <p className="text-xs">
              Chrome uses accent-tuned recognition for improved consistency.
              Select your accent in settings for best results.
            </p>
          </TooltipContent>
        </Tooltip>
      </TooltipProvider>
    );
  }
  
  return (
    <Badge variant="outline" className="text-xs">
      {browser.browserName}
    </Badge>
  );
}

// Re-export types and utilities
export { ACCENT_OPTIONS, type AccentCode };
