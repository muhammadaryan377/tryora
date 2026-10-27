#!/usr/bin/env python3
"""Resolve the specific Tryora e3e98c3 cherry-pick conflict without reverting safety changes.
Run from Tryora repository root while the cherry-pick is paused.
This script makes a backup and fails closed if the conflict format changed.
"""
from pathlib import Path
import sys, re, subprocess, shutil, tempfile

root = Path.cwd()
if not (root / 'packages/storefront/src/main.ts').is_file():
    sys.exit('ERROR: Run this script from C:\\Users\\malik\\Downloads\\tryora-assistant-v2 (repo root).')
check = subprocess.run(['git','rev-parse','-q','--verify','CHERRY_PICK_HEAD'], capture_output=True, text=True)
if check.returncode != 0:
    sys.exit('ERROR: No paused cherry-pick found. Refusing to edit.')

C = Path('shopify-app/app/components/fabric-colour-manager.tsx')
M = Path('shopify-app/app/customization/fabric-manager.ts')
S = Path('shopify-app/extensions/tryora-theme/assets/tryora.css')
FILES = [C,M,S,
         Path('packages/storefront/src/swatch-appearance.ts'),
         Path('packages/storefront/src/assistant/options.ts'),
         Path('shopify-app/app/assistant/options.server.ts'),
         Path('shopify-app/test/fabric-layout.test.ts')]

for p in (C,M,S):
    if not (root/p).exists() or '<<<<<<< HEAD' not in (root/p).read_text(encoding='utf-8'):
        sys.exit(f'ERROR: Expected a paused conflict in {p}. No files changed.')

def replace_once(s,old,new, label):
    n=s.count(old)
    if n!=1: raise ValueError(f'{label}: expected exactly 1 occurrence, found {n}. No files changed.')
    return s.replace(old,new)

def select_ours(src, label):
    lines=src.splitlines(keepends=True)
    output=[]; block=[]; phase='outside'; n=0
    for ln in lines:
        if ln.startswith('<<<<<<< '):
            if phase!='outside': raise ValueError(f'{label}: nested conflict')
            phase='ours'; block=[]; n+=1
        elif ln.startswith('=======') and phase=='ours':
            phase='theirs'
        elif ln.startswith('>>>>>>> ') and phase=='theirs':
            output.extend(block)
            phase='outside'
        elif phase=='outside': output.append(ln)
        elif phase=='ours': block.append(ln)
    if phase!='outside': raise ValueError(f'{label}: malformed markers')
    if n==0: raise ValueError(f'{label}: no conflict blocks')
    return ''.join(output),n
raw={p:(root/p).read_text(encoding='utf-8') for p in FILES}
new=dict(raw)
for p in [C,M,S]:
    new[p],n=select_ours(raw[p],str(p))
    print(f'Preserved existing safe code in {p}: {n} conflict blocks')

# The incoming branch adds a second swatch editor using a different data key.
# Keep the original single editor, extend it with Rectangle, and persist both compatible formats.
s=new[C]
s=replace_once(s,
    '  const swatchShape = draft.presentation?.shape ?? DEFAULT_SWATCH_PRESENTATION.shape;\n'
    '  const swatchSize = draft.presentation?.size ?? DEFAULT_SWATCH_PRESENTATION.size;',
    '  const swatchShape = draft.swatchAppearance?.shape === "rectangle" ? "rectangle" : draft.presentation?.shape ?? DEFAULT_SWATCH_PRESENTATION.shape;\n'
    '  const swatchSize = draft.swatchAppearance?.size ?? draft.presentation?.size ?? DEFAULT_SWATCH_PRESENTATION.size;',
    'derive compatible swatch shape/size')
s=replace_once(s,
    '  const updateSwatchPresentation = (patch: Partial<{ shape: "round" | "square"; size: number }>) =>\n'
    '    setDraft((value) => ({ ...value, presentation: { shape: swatchShape, size: swatchSize, ...patch } }));',
    '''  const updateSwatchPresentation = (patch: Partial<{ shape: "round" | "square" | "rectangle"; size: number }>) =>
    setDraft((value) => {
      const shape = patch.shape ?? (value.swatchAppearance?.shape === "rectangle" ? "rectangle" : value.presentation?.shape ?? "round");
      const size = patch.size ?? value.swatchAppearance?.size ?? value.presentation?.size ?? DEFAULT_SWATCH_PRESENTATION.size;
      if (shape === "rectangle") return { ...value, presentation: undefined, swatchAppearance: { shape: "rectangle" as const, size } };
      if (shape === "square") return { ...value, presentation: { shape: "square" as const, size }, swatchAppearance: undefined };
      return { ...value, presentation: { shape: "round" as const, size }, swatchAppearance: { shape: "circle" as const, size } };
    });''',
    'safe synchronized appearance update')
# Incoming has an extra editor with the same name, which would result in duplicate UI.
s,count=re.subn(r'\n\s*<section className="fm-appearance" aria-labelledby="fm-appearance-title">.*?</section>', '', s, flags=re.S)
if count!=1: raise ValueError(f'new swatch appearance duplicate removal expected 1, found {count}')
s=replace_once(s,
    '  const appearance = draft.swatchAppearance ?? { shape: "circle", size: 50 };\n','',
    'remove redundant appearance selector')
# Incoming cherry-pick already supplies the new heading plus a simple Save.
# Remove duplicate Save in the product bar; replace new one with safe validated Save.
save_markup='''          {p && <div className="fm-save">
            <span className={`fm-pill fm-pill--${dirty || colourDraft ? "attention" : "success"}`} role="status">{colourDraft ? "Editing a colour" : dirty ? "Unsaved changes" : p.saved ? "Saved" : "No unsaved changes"}</span>
            <button className="fm-btn fm-btn--primary" type="button" disabled={busy || saveBlocked} onClick={() => { saving.current = true; save(mode, manual ? { ...draft, presentation: draft.presentation ?? DEFAULT_SWATCH_PRESENTATION } : draft); }}>{busy ? "Saving…" : "Save changes"}</button>
          </div>}
'''
incoming_save=''.join(line[2:] if line.startswith('  ') else line for line in save_markup.splitlines(keepends=True)).replace('manual ? { ...draft, presentation: draft.presentation ?? DEFAULT_SWATCH_PRESENTATION } : draft', 'draft')
if s.count(save_markup)!=1 or s.count(incoming_save)!=1 or '<div className="fm-page-heading">' not in s or 'return <s-page inlineSize="large">' not in s:
    raise ValueError('Expected one existing Save and one incoming header Save; source changed')
new_save=save_markup.replace('manual ? { ...draft, presentation: draft.presentation ?? DEFAULT_SWATCH_PRESENTATION } : draft',
  'manual ? (draft.swatchAppearance?.shape === "rectangle" ? { ...draft, presentation: undefined } : { ...draft, presentation: draft.presentation ?? DEFAULT_SWATCH_PRESENTATION }) : draft')
new_save=''.join(line[2:] if line.startswith('  ') else line for line in new_save.splitlines(keepends=True))
s=s.replace(incoming_save,new_save,1)
s=s.replace(save_markup,'',1)
# Existing product-list fabric hex sample remains; only grow thumbnail.
s=replace_once(s,
 'hex={f.hex && HEX.test(f.hex) ? f.hex : null} label={`${f.name || "Untitled fabric"} texture`} empty="No texture" size={44}',
 'hex={f.hex && HEX.test(f.hex) ? f.hex : null} label={`${f.name || "Untitled fabric"} texture`} empty="No texture" size={64}',
 'preserve real HEX/texture with new layout')
# Keep 25-100 integer input, add rectangle shape (beside circle and square) using the same settings.
s=replace_once(s,
 '                    <button type="button" className="fm-btn fm-shape" aria-label="Square swatches" aria-pressed={swatchShape === "square"} onClick={() => updateSwatchPresentation({ shape: "square" })}><span className="fm-shape-square" /></button>',
 '                    <button type="button" className="fm-btn fm-shape" aria-label="Square swatches" aria-pressed={swatchShape === "square"} onClick={() => updateSwatchPresentation({ shape: "square" })}><span className="fm-shape-square" /></button>\n'
 '                    <button type="button" className="fm-btn fm-shape fm-shape-with-label" aria-label="Rectangle swatches" aria-pressed={swatchShape === "rectangle"} onClick={() => updateSwatchPresentation({ shape: "rectangle" })}><span className="fm-shape-rectangle" />Rectangle</button>',
 'third shape choice')
# Existing Thumb from incoming branch accepts rectangle shape and renders 70% height.
if 'shape?: "round" | "square" | "rectangle"' not in s: raise ValueError('Thumb must include rectangle from incoming patch')
# Simpler markup to support the new explanatory copy without losing the original controls.
s=replace_once(s,
 '                <div className="fm-section-head fm-colours-head"><h3>Colours <span className="fm-count">{fabric.colours.length}</span></h3>',
 '                <div className="fm-section-head fm-colours-head"><div><h3>Colours <span className="fm-count">{fabric.colours.length}</span></h3><p className="fm-muted">Add a name and a HEX colour or sample image.</p></div>',
 'colour panel heading')
s=replace_once(s,
 '                  <button className="fm-btn" type="button" disabled={!!colourDraft} onClick={() => setColourDraft({ id: uid(), name: "", enabled: true, swatchMediaId: null, hex: null, isNew: true })}>+ Add colour</button></div>',
 '                  <button className="fm-btn fm-btn--primary" type="button" disabled={!!colourDraft} onClick={() => setColourDraft({ id: uid(), name: "", enabled: true, swatchMediaId: null, hex: null, isNew: true })}>+ Add colour</button></div>',
 'colour action')
s=replace_once(s,
 '                    <span className={`fm-pill fm-pill--${status.tone}`}>{status.label}</span><span className="fm-edit-label">Edit <span aria-hidden="true">↗</span></span>',
 '                    <span className={`fm-pill fm-pill--${status.tone}`}>{status.label}</span><span className="fm-edit-label">Edit <span aria-hidden="true">↗</span></span>', 'verify edit label') if False else s
if '<span className="fm-edit-label">Edit ' not in s: raise ValueError('Incoming UI label not applied')
styles="""
/* Rectangle inherits saved swatch appearance without duplicating controls. */
.fm-shape-with-label{width:auto;gap:6px;padding:6px 10px}
.fm-shape-rectangle{display:block;width:22px;height:15px;background:var(--fm-accent);border-radius:2px}
"""
pos=s.rfind('\n`;')
if pos<0 or 'const STYLES = `' not in s: raise ValueError('Cannot find end of stylesheet')
s=s[:pos]+styles+s[pos:]
new[C]=s

# The parser validates both persisted settings, preserving old installations and new rectangles.
s=new[M]
s=replace_once(s,
 'export interface FabricDraft { fabrics: ManagedFabric[]; bindings: ManagedBinding[]; roles: ManualMapping["roles"]; /** Optional for older saved records. */ presentation?: SwatchPresentation }',
 'export interface SwatchAppearance { shape: "circle" | "rectangle"; size: number }\n'
 'export interface FabricDraft { fabrics: ManagedFabric[]; bindings: ManagedBinding[]; roles: ManualMapping["roles"]; /** Optional for older saved records. */ presentation?: SwatchPresentation; swatchAppearance?: SwatchAppearance }',
 'preserve old and new appearance schema')
s=replace_once(s,
 'keys(raw, ["fabrics", "bindings", "roles", "presentation"])',
 'keys(raw, ["fabrics", "bindings", "roles", "presentation", "swatchAppearance"])',
 'whitelist the new appearance')
old_guard="""  if (raw.swatchAppearance !== undefined) {
    const appearance = raw.swatchAppearance;
    if (!record(appearance) || !keys(appearance, ["shape", "size"]) ||
        typeof appearance.shape !== "string" || !["circle", "rectangle"].includes(appearance.shape) || ![25, 50, 75, 100].includes(appearance.size as number))
      throw new FabricConfigError("Choose a circle or rectangle and a swatch size of 25, 50, 75 or 100 px.");
  }
"""
new_guard="""  if (raw.swatchAppearance !== undefined) {
    const appearance = raw.swatchAppearance;
    if (!record(appearance) || !keys(appearance, ["shape", "size"]) ||
        !(appearance.shape === "circle" || appearance.shape === "rectangle") ||
        typeof appearance.size !== "number" || !Number.isInteger(appearance.size) ||
        appearance.size < 25 || appearance.size > 100)
      throw new FabricConfigError("Choose a circle or rectangle and a swatch size from 25 to 100 px.");
  }
"""
s=replace_once(s,old_guard,new_guard,'replace incoming schema validator')
new[M]=s

# Preserve the original product-gallery-safe presentation CSS, append incoming assistant styles.
s=new[S]
addition='''
/* Merchant rectangle samples wrap on desktop but continue to scroll on phones. */
.tryora__swrow--custom{display:flex;flex-wrap:wrap;gap:12px;padding:4px}
.tryora__swrow--custom.tryora__swrow--scroll{flex-wrap:nowrap}
.tryora-assistant__optrow.is-colour .tryora-assistant__swatch-dot[style] > i,
.tryora-assistant__optrow.is-colour .tryora-assistant__swatch-dot[style] > img{border-radius:inherit}
'''
if '.tryora__swrow--custom{' not in s: s=s.rstrip()+ '\n' +addition
new[S]=s

# The incoming model constrained sizes to four presets. Support all integer values
# from 25–100px, as already supported in the shipped selector.
p=Path('packages/storefront/src/swatch-appearance.ts');s=new[p]
s=replace_once(s,'size: 25 | 50 | 75 | 100','size: number','storefront swatch numeric size')
s=replace_once(s,'![25, 50, 75, 100].includes(size)',
                  '!(Number.isInteger(size) && size >= 25 && size <= 100)',
                  'storefront swatch safe size validation')
new[p]=s
for p in [Path('packages/storefront/src/assistant/options.ts'),Path('shopify-app/app/assistant/options.server.ts')]:
    s=new[p]
    s=replace_once(s, 'size: 25 | 50 | 75 | 100', 'size: number', f'{p} swatch interface')
    new[p]=s

# Update new tests to cover current UX and retain existing rollout gate.
p=Path('shopify-app/test/fabric-layout.test.ts');s=new[p]
s=replace_once(s,'installationReady: true, products:', 'installationReady: true, advanced: true, products:', 'enable advanced test fixture')
s=replace_once(s, 'textureMediaId: null, colours: [{ id: "ivory"', 'textureMediaId: null, hex: "#DDDDDD", colours: [{ id: "ivory"', 'make test fabric valid under Shopify Files sample rules')
s=replace_once(s, "await act(async () => button('Rectangle').click());", "await act(async () => container.querySelector<HTMLButtonElement>('[aria-label=\"Rectangle swatches\"]')!.click());", 'new rectangle selector test')
s=replace_once(s, "const size = container.querySelector<HTMLSelectElement>('[aria-label=\"Swatch size\"]')!;", "const size = container.querySelector<HTMLInputElement>('[aria-label=\"Swatch size\"]')!;", 'size is a numeric input not a preset selector')
s=replace_once(s, "size.dispatchEvent(new Event('change', { bubbles: true }));", "size.dispatchEvent(new Event('input', { bubbles: true }));", 'simulate numeric input change')
s=replace_once(s, "expect(container.querySelector('#fm-mapping > summary')?.textContent).toContain('Advanced settings');", "expect(container.querySelector('.fm-advanced-setup > summary')?.textContent).toContain('Advanced AI preview setup');", 'respect advanced permissions gating')
new[p]=s

for p,s in new.items():
    if re.search(r'^(?:<<<<<<<|=======|>>>>>>>)',s,re.M):
        raise ValueError(f'Unresolved merge marker in {p}. No files changed.')
# A fail-closed, rollback-friendly edit.
backup=Path(tempfile.mkdtemp(prefix='tryora_fabric_merge_backup_'))
for p in FILES:
    dest=backup/p
    dest.parent.mkdir(parents=True,exist_ok=True)
    shutil.copyfile(root/p,dest)
for p,s in new.items():
    if raw[p]!=s:
        (root/p).write_text(s,encoding='utf-8',newline='\n')
        print(f'Updated {p}')
print(f'\nBACKUPS SAVED: {backup}')
print('NEXT: run `git diff --check`, `npm run typecheck`, targeted Shopify tests and `npm run build`.')
print('If all pass: stage only the files above + generated theme asset; `git cherry-pick --continue`.')
