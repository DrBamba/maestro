import type { GitignoreTemplate } from '@shared/types'

/**
 * Starter files for a new repo. Kept short and offline on purpose: GitHub's own templates are a
 * network call away and run to hundreds of lines, most of it for tools nobody here uses.
 */

const COMMON = ['# OS', '.DS_Store', 'Thumbs.db', '', '# Editors', '.idea/', '.vscode/', '*.swp', '']

const GITIGNORE: Record<Exclude<GitignoreTemplate, 'none'>, string[]> = {
  Node: [
    '# Node',
    'node_modules/',
    'dist/',
    'build/',
    'out/',
    'coverage/',
    '.env',
    '.env.*',
    '!.env.example',
    'npm-debug.log*',
    'yarn-error.log*',
    'pnpm-debug.log*'
  ],
  Python: [
    '# Python',
    '__pycache__/',
    '*.py[cod]',
    '.venv/',
    'venv/',
    'env/',
    '.env',
    'build/',
    'dist/',
    '*.egg-info/',
    '.pytest_cache/',
    '.mypy_cache/',
    '.ruff_cache/',
    '.coverage',
    'htmlcov/'
  ],
  Go: ['# Go', '/bin/', '*.exe', '*.test', '*.out', 'coverage.*', 'go.work', 'go.work.sum', '.env'],
  Rust: ['# Rust', '/target/', '**/*.rs.bk', '*.pdb', '.env'],
  Swift: [
    '# Swift',
    '.build/',
    'DerivedData/',
    '.swiftpm/',
    'Packages/',
    '*.xcuserstate',
    'xcuserdata/',
    '*.ipa',
    '*.dSYM.zip',
    '*.dSYM'
  ],
  Java: [
    '# Java',
    '*.class',
    '*.jar',
    '*.war',
    '*.log',
    'target/',
    'build/',
    '.gradle/',
    'out/',
    'hs_err_pid*'
  ]
}

export function gitignoreFor(template: Exclude<GitignoreTemplate, 'none'>): string {
  return [...GITIGNORE[template], '', ...COMMON].join('\n')
}

export function readmeFor(name: string): string {
  return `# ${name}\n`
}

export function mitLicense(holder: string, year: number): string {
  return `MIT License

Copyright (c) ${year} ${holder}

Permission is hereby granted, free of charge, to any person obtaining a copy
of this software and associated documentation files (the "Software"), to deal
in the Software without restriction, including without limitation the rights
to use, copy, modify, merge, publish, distribute, sublicense, and/or sell
copies of the Software, and to permit persons to whom the Software is
furnished to do so, subject to the following conditions:

The above copyright notice and this permission notice shall be included in all
copies or substantial portions of the Software.

THE SOFTWARE IS PROVIDED "AS IS", WITHOUT WARRANTY OF ANY KIND, EXPRESS OR
IMPLIED, INCLUDING BUT NOT LIMITED TO THE WARRANTIES OF MERCHANTABILITY,
FITNESS FOR A PARTICULAR PURPOSE AND NONINFRINGEMENT. IN NO EVENT SHALL THE
AUTHORS OR COPYRIGHT HOLDERS BE LIABLE FOR ANY CLAIM, DAMAGES OR OTHER
LIABILITY, WHETHER IN AN ACTION OF CONTRACT, TORT OR OTHERWISE, ARISING FROM,
OUT OF OR IN CONNECTION WITH THE SOFTWARE OR THE USE OR OTHER DEALINGS IN THE
SOFTWARE.
`
}
