Run npm run dist:win -- --publish never

> requii@0.1.0 dist:win
> npm run build && powershell -NoProfile -ExecutionPolicy Bypass -File ./scripts/build-windows.ps1 all --publish never


> requii@0.1.0 build
> npm run build:electron && npm run typecheck:app && vite build


> requii@0.1.0 build:electron
> tsc -p tsconfig.electron.json


> requii@0.1.0 typecheck:app
> tsc -p tsconfig.app.json --noEmit

Error: src/utils/tree.ts(80,77): error TS2345: Argument of type 'string[] | (string & any[])' is not assignable to parameter of type 'string'.
  Type 'string[]' is not assignable to type 'string'.

- allow file uploads as fields of JSON body