# Example app

Components need an app that uses them in order to run codegen.

An example app is also useful for testing and documentation.

Run the example and convex commands from the root of the repo.

```sh
npm run dev            # pushes example/convex and watches the component
npm run dev:frontend   # serves the page in example/src
```

The page calls the public functions in `convex/demo.ts`. They start background
runs with `migrations.start` and read `migrations.status`. The four registered
functions in `convex/migrations.ts` stay internal.
