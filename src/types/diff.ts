export interface ChangeClassification {
  content: ContentChange[];
  style: StyleChange[];
  structure: StructureChange[];
}

export interface ContentChange {
  type: 'content';
  priority: number;
  element: string;
  position: { line: number; column: number };
  change: 'added' | 'removed' | 'modified';
  before?: string;
  after?: string;
  context?: string;
}

export interface StyleChange {
  type: 'style';
  priority: number;
  element: string;
  attribute: string;
  change: 'added' | 'removed' | 'modified';
  before?: string;
  after?: string;
  position?: { line: number; column: number };
}

export interface StructureChange {
  type: 'structure';
  priority: number;
  change: 'added' | 'removed' | 'moved';
  element: string;
  position?: { line: number; column: number };
  newPosition?: { line: number; column: number };
  attributes?: Record<string, string>;
}

export interface DetailedDiff {
  url: string;
  date: string;
  previousHash: string;
  currentHash: string;
  classification: ChangeClassification;
  summary: {
    totalChanges: number;
    contentChanges: number;
    styleChanges: number;
    structureChanges: number;
    highestPriority: number;
  };
  metadata: {
    generatedAt: string;
    generationTime: number;
    isPartial: boolean;
    cacheKey?: string;
  };
}

export interface DiffViewerState {
  siteId: string;
  date: string;
  selectedView: 'all' | 'content' | 'style' | 'structure';
  selectedUrlHash?: string;
  compareMode: 'side-by-side' | 'unified';
  showContext: boolean;
  contextLines: number;
}

export interface UrlHistoryEntry {
  url: string;
  urlHash: string;
  dates: string[];
  lastChanged?: string;
  totalChanges: number;
}

export interface DiffGenerationOptions {
  includeContent: boolean;
  includeStyle: boolean;
  includeStructure: boolean;
  maxChanges?: number;
  progressiveLoad?: boolean;
  cacheEnabled?: boolean;
}

export interface DiffCacheEntry {
  key: string;
  diff: DetailedDiff;
  expiresAt: number;
}

export interface FrameworkPattern {
  name: string;
  patterns: {
    selector: string;
    attributes?: string[];
    dynamicAttributes?: string[];
  }[];
  ignorePatterns: string[];
}

export const FRAMEWORK_PATTERNS: Record<string, FrameworkPattern> = {
  wordpress: {
    name: 'WordPress',
    patterns: [
      {
        selector: '.wp-block',
        attributes: ['data-block'],
        dynamicAttributes: ['id']
      },
      {
        selector: '[class*="wp-"]',
        dynamicAttributes: ['id', 'data-id']
      }
    ],
    ignorePatterns: [
      'wp-block-[a-z0-9]+-[a-f0-9]{8,}',
      'post-\\d+',
      'page_\\d+'
    ]
  },
  react: {
    name: 'React',
    patterns: [
      {
        selector: '[data-reactroot]',
        dynamicAttributes: ['data-reactid', 'data-react-checksum']
      },
      {
        selector: '[class*="css-"]',
        dynamicAttributes: ['class']
      }
    ],
    ignorePatterns: [
      'css-[a-z0-9]+-[a-z0-9]+',
      'react-\\d+'
    ]
  },
  vue: {
    name: 'Vue',
    patterns: [
      {
        selector: '[data-v-]',
        dynamicAttributes: ['data-v-*']
      }
    ],
    ignorePatterns: [
      'data-v-[a-f0-9]{8}'
    ]
  },
  angular: {
    name: 'Angular',
    patterns: [
      {
        selector: '[ng-]',
        dynamicAttributes: ['_ngcontent', '_nghost']
      }
    ],
    ignorePatterns: [
      '_ngcontent-[a-z0-9]+',
      '_nghost-[a-z0-9]+'
    ]
  }
};
