# Latent Scope

[![](https://dcbadge.vercel.app/api/server/x7NvpnM4pY?style=flat)](https://discord.gg/x7NvpnM4pY)
[![PyPI version](https://img.shields.io/pypi/v/latentscope.svg)](https://pypi.org/project/latentscope/)

Quickly embed, project, cluster and explore a dataset with open models locally or via API. This project is a new kind of workflow + tool for visualizing and exploring datasets through the lens of latent spaces.

[Docs](https://enjalot.github.io/latent-scope/) · [Demos](https://latent.estate)

| [![](https://storage.googleapis.com/fun-data/latent-scope/demos/enjalot/ls-fineweb-edu-100k/scopes-001.png)](http://latent.estate/scope/enjalot/ls-fineweb-edu-100k/scopes-001) | [![](https://storage.googleapis.com/fun-data/latent-scope/demos/enjalot/ls-dadabase/scopes-001.png)](https://latent.estate/scope/enjalot/ls-dadabase/scopes-001) | [![](https://storage.googleapis.com/fun-data/latent-scope/demos/enjalot/ls-common-corpus-100k/scopes-001.png)](https://latent.estate/scope/enjalot/ls-common-corpus-100k/scopes-001) | [![](https://storage.googleapis.com/fun-data/latent-scope/demos/enjalot/ls-dataisplural/scopes-001.png)](https://latent.estate/scope/enjalot/ls-dataisplural/scopes-001) |
| :-----------------------------------------------------------------------------------------------------------------------------------------------------------------------------: | :--------------------------------------------------------------------------------------------------------------------------------------------------------------: | :----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------: | :----------------------------------------------------------------------------------------------------------------------------------------------------------------------: |
|                                                [Fineweb EDU](http://latent.estate/scope/enjalot/ls-fineweb-edu-100k/scopes-001)                                                 |                                             [Dad Jokes](https://latent.estate/scope/enjalot/ls-dadabase/scopes-001)                                              |                                                [Common Corpus](https://latent.estate/scope/enjalot/ls-common-corpus-100k/scopes-001)                                                 |                                             [Data is Plural](https://latent.estate/scope/enjalot/ls-dataisplural/scopes-001)                                             |

Latent Scope encodes a process that is increasingly common in AI and data science workflows: Embed unstructured data into high-dimensional vectors, reduce the dimensionality of those vectors, cluster the resulting points, label the clusters with an LLM and then explore the annotated data.

<img src="https://github.com/enjalot/latent-scope/blob/main/documentation/process-crop.png?raw=true"  alt="Setup your scope">

In addition to making this process easier by providing a web interface for each step, Latent Scope provides an intuitive way to explore the resulting annotated data via an interactive visualization tightly coupled with the input data.

<img src="https://github.com/enjalot/latent-scope/blob/main/documentation/explore.png?raw=true" alt="Explore and your data">

## Getting started

Follow the documentation guides to get started:

1. [Install and Configure](https://enjalot.github.io/latent-scope/install-and-config)
2. [Your First Scope](https://enjalot.github.io/latent-scope/your-first-scope)
3. [Explore and Curate](https://enjalot.github.io/latent-scope/explore-and-curate)
4. [Exporting Data](https://enjalot.github.io/latent-scope/exporting-data)

## Example Analysis

What can you do with Latent Scope? The following examples demonstrate the kinds of perspective and insights you can gain from your unstructured text data.

- Explore free-responses from surveys in this [datavis survey analysis](https://enjalot.github.io/latent-scope/datavis-survey)
- Cluster thousands of [GitHub issues and PRs](https://enjalot.github.io/latent-scope/plot-issues)
- Explore 50,000 [US Federal laws](https://enjalot.github.io/latent-scope/us-federal-laws) spanning two hundred years.

### Quick Start

Latent Scope works on Mac, Linux and Windows. Python 3.12 is the recommended python version.

To get started, install the [latent-scope python module](https://pypi.org/project/latentscope/) and run the server via the Command Line:

```bash
python -m venv venv
source venv/bin/activate
pip install latentscope
ls-init ~/latent-scope-data --openai_key=XXX --mistral_key=YYY # optional api keys to enable API models
ls-serve
```

Then open your browser to http://localhost:5001 and start processing your first dataset!

See the [Your First Scope](https://enjalot.github.io/latent-scope/your-first-scope) guide for a detailed walk-through of the process.

### Hosted and single-profile modes

You can run one frontend build in different server modes using environment variables:

```bash
# default local authoring mode
LATENT_SCOPE_APP_MODE=studio

# hosted mode: explore + twitter import (no setup/settings)
LATENT_SCOPE_APP_MODE=hosted

# single profile mode: serve one public explore view only
LATENT_SCOPE_APP_MODE=single_profile
LATENT_SCOPE_PUBLIC_DATASET=your-dataset-id
LATENT_SCOPE_PUBLIC_SCOPE=scopes-001

# optional hosted limits
LATENT_SCOPE_MAX_UPLOAD_MB=1024
LATENT_SCOPE_JOB_TIMEOUT_SEC=1800
```

In hosted mode, the native X archive form supports a browser-side privacy mode that extracts/minimizes tweet JSON locally before upload.

For Vercel deployment of demo + hosted variants from one GitHub repo, see `documentation/vercel-deployment.md`.

### Python interface

You can also ingest data from a Pandas dataframe using the Python interface:

```python
import latentscope as ls
df = pd.read_parquet("...")
ls.init("~/latent-scope-data") # you can also pass in openai_key="XXX", mistral_key="XXX" etc.)
ls.ingest("dadabase", df, text_column="joke")
ls.serve()
```

See these notebooks for detailed examples of using the Python interface to prepare and load data.

- [dvs-survey](notebooks/dvs-survey.ipynb) - A small test dataset of 700 rows to quickly illustrate the process. This notebook shows how you can do every step of the process with the Python interface.
- [dadabase](notebooks/dadabase.ipynb) - A more interesting (and funny) dataset of 50k rows. This notebook shows how you can preprocess a dataset, ingest it into latentscope and then use the web interface to complete the process.
- [dolly15k](notebooks/dolly15k.ipynb) - Grab data from HuggingFace datasets and ingest into the process.
- [emotion](notebooks/emotion.ipynb) - 400k rows of emotional tweets.

### Command line quick start

When latent-scope is installed, it creates a suite of command line scripts that can be used to setup the scopes for exploring in the web application. The output of each step in the process is flat files stored in the data directory specified at init. These files are in standard formats that were designed to be ported into other pipelines or interfaces.

```bash
# like above, we make sure to install latent-scope
python -m venv venv
source venv/bin/activate
pip install latent-scope

# prepare some data
wget "https://storage.googleapis.com/fun-data/latent-scope/examples/dvs-survey/datavis-misunderstood.csv" > ~/Downloads/datavis-misunderstood.csv

ls-init "~/latent-scope-data"
# ls-ingest dataset_id csv_path
ls-ingest-csv "datavis-misunderstood" "~/Downloads/datavis-misunderstood.csv"
# get a list of model ids available (lists both embedding and chat models available)
ls-list-models
# ls-embed dataset_id text_column model_id prefix
ls-embed datavis-misunderstood "answer" transformers-intfloat___e5-small-v2 ""
# ls-umap dataset_id embedding_id n_neighbors min_dist
ls-umap datavis-misunderstood embedding-001 25 .1
# ls-cluster dataset_id umap_id samples min_samples
ls-cluster datavis-misunderstood umap-001 5 5
# ls-label dataset_id text_column cluster_id model_id context
ls-label datavis-misunderstood "answer" cluster-001 transformers-HuggingFaceH4___zephyr-7b-beta ""
# ls-scope  dataset_id embedding_id umap_id cluster_id cluster_labels_id label description
ls-scope datavis-misunderstood cluster-001-labels-001 "E5 demo" "E5 embeddings summarized by Zephyr 7B"
# start the server to explore your scope
ls-serve
```

### Repository overview

This repository is currently meant to run locally, with a React frontend that communicates with a python server backend. We support several popular open source embedding models that can run locally as well as proprietary API embedding services. Adding new models and services should be quick and easy.

To learn more about contributing and the project roadmap see [CONTRIBUTION.md](CONTRIBUTION.md), for technical details see [DEVELOPMENT.md](DEVELOPMENT.md).

### Design principles

This tool is meant to be a part of a larger process. Something that hopefully helps you see things in your data that you wouldn't otherwise have. That means it needs to be easy to get data in, and easily get useful data out.

1. Flat files

- All of the data that drives the app is stored in flat files. This is so that both final and intermediate outputs can easily be exported for other uses. It also makes it easy to see the status of any part of the process.

2. Remember everything

- This tool is intended to aid in research, the purpose is experimentation and exploration. I developed it because far too often I try a lot of things and then I forget what parameters lead me down a promising path in the first place. All choices you make in the process are recorded in metadata files along with the output of the process.

3. It's all about the indices

- We consider an input dataset the source of truth, a list of rows that can be indexed into. So all downstream operations, whether its embeddings, pointing to nearest neighbors or assigning data points to clusters, all use indices into the input dataset.

### Visualization Color Principles (Explore V2)

The V2 graph + sidebar color system follows a few strict rules so interaction states remain legible at scale:

- Separate semantics:
  Cluster identity uses categorical hue.
  Interaction state (hover, selected, filtered) uses stroke/size/opacity, not hue-swaps.
- Use mode-specific palettes:
  Light mode uses darker accent tones over warm paper backgrounds.
  Dark mode uses lighter accent tones over dark backgrounds.
- Keep cross-panel color identity stable:
  A cluster should keep the same hue in the scatter, hulls, topic tree, search icon, and tweet avatar.
- Avoid color-only signaling:
  Selection and hover always include non-color cues for accessibility.
- Keep label chips subtle:
  Label backgrounds are map-tinted and low-opacity (not hard white/black blocks).
- Keep elevation neutral:
  Use Flexoki-neutral shadow tokens (not pure black ramps) so depth doesn’t introduce a second color system.
- Keep panel/map harmony:
  Sidebar glass uses the same base hue family as map background; differences should read as elevation, not palette mismatch.
- Keep labels non-blocking:
  Label text should not intercept point hover/click. Use lightweight label anchors for label-click affordance.

Implementation notes:

- Theme tokens: `web/src/latentscope--brand-theme.scss`
- Cluster palette + scatter labels: `web/src/components/Explore/V2/DeckGLScatter.jsx`
- Hull/annotation/hover card color sync: `web/src/components/Explore/V2/VisualizationPane.jsx`
- Topic tree cluster-state color sync: `web/src/components/Explore/V2/TopicTree.jsx`
- Sidebar layout/motion + panel surfaces: `web/src/pages/V2/FullScreenExplore.jsx`
- Explore shell styling (rounded clipping, buttons, shadows): `web/src/pages/V2/Explore.css`

References used for the color system:

- Flexoki (palette + token model): https://stephango.com/flexoki
- ColorBrewer scheme taxonomy: https://colorbrewer2.org/learnmore/schemes_full.html
- Seaborn palette guidance (categorical vs numeric): https://seaborn.pydata.org/tutorial/color_palettes.html
- WCAG 2.1, Use of Color: https://www.w3.org/WAI/WCAG21/Understanding/use-of-color.html
- WCAG 2.1, Non-text Contrast: https://www.w3.org/WAI/WCAG21/Understanding/non-text-contrast.html

## Command Line Scripts: Detailed description

If you want to use the CLI instead of the web UI you can use the following scripts.

The scripts should be run in order once you have an `input.csv` file in your folder. Alternatively the Setup page in the web UI will run these scripts via API calls to the server for you.  
These scripts expect at the least a `LATENT_SCOPE_DATA` environment variable with a path to where you want to store your data. If you run `ls-serve` it will set the variable and put it in a `.env` file. You can add API keys to the .env file to enable usage of the various API services, see [.env.example](.env.example) for the structure.

For hosted deployments, you can also set `LATENT_SCOPE_APP_MODE`, `LATENT_SCOPE_MAX_UPLOAD_MB`, and `LATENT_SCOPE_JOB_TIMEOUT_SEC`.

### 0. ingest

This script turns the `input.csv` into `input.parquet` and sets up the directories and `meta.json` which run the app.

```bash
# ls-ingest <dataset_name>
ls-ingest database-curated
```

### 0b. twitter import

Import a native X export zip or a community archive, and optionally run the full pipeline:

```bash
# native X export zip
ls-twitter-import visakanv --source zip --zip_path ~/Downloads/my-twitter-archive.zip --run_pipeline

# community archive by username
ls-twitter-import visakanv --source community --username visakanv --run_pipeline
```

### 1. embed

Take the text from the input and embed it. Default is to use `BAAI/bge-small-en-v1.5` locally via HuggingFace transformers. API services are supported as well, see [latentscope/models/embedding_models.json](latentscope/models/embedding_models.json) for model ids.

```bash
# you can get a list of models available with:
ls-list-models
# ls-embed <dataset_name> <text_column> <model_id>
ls-embed dadabase joke transformers-intfloat___e5-small-v2
```

### 2. umap

Map the embeddings from high-dimensional space to 2D with UMAP. Will generate a thumbnail of the scatterplot.

```bash
# ls-umap <dataset_name> <embedding_id> <neighbors> <min_dist>
ls-umap dadabase embedding-001 50 0.1
```

### 3. cluster

Cluster the UMAP points using HDBSCAN. This will label each point with a cluster label

```bash
# ls-cluster <dataset_name> <umap_id> <samples> <min-samples>
ls-cluster dadabase umap-001 5 3
```

### 4. label

We support auto-labeling clusters by summarizing them with an LLM. Supported models and APIs are listed in [latentscope/models/chat_models.json](latentscope/models/chat_models.json).
You can pass context that will be injected into the system prompt for your dataset.

```bash
# ls-label <dataset_id> <cluster_id> <chat_model_id> <context>
ls-label dadabase "joke" cluster-001 openai-gpt-3.5-turbo ""
```

### 5. scope

The scope command ties together each step of the process to create an explorable configuration. You can have several scopes to view different choices, for example using different embeddings or even different parameters for UMAP and clustering. Switching between scopes in the UI is instant.

```bash
# ls-scope  <dataset_id> <embedding_id> <umap_id> <cluster_id> <cluster_labels_id> <label> <description>
ls-scope datavis-misunderstood cluster-001-labels-001 "E5 demo" "E5 embeddings summarized by GPT3.5-Turbo"
```

### 6. serve

To start the web UI we run a small server. This also enables nearest neighbor similarity search and interactively querying subsets of the input data while exploring the scopes.

```bash
ls-serve ~/latent-scope-data
```

## Dataset directory structure

Each dataset will have its own directory in data/ created when you ingest your CSV. All subsequent steps of setting up a dataset write their data and metadata to this directory.
There are no databases in this tool, just flat files that are easy to copy and edit.

<pre>
├── data/
|   ├── dataset1/
|   |   ├── input.parquet                           # from ingest.py, the dataset
|   |   ├── meta.json                               # from ingest.py, metadata for dataset, #rows, columns, text_column
|   |   ├── embeddings/
|   |   |   ├── embedding-001.h5                    # from embed.py, embedding vectors
|   |   |   ├── embedding-001.json                  # from embed.py, parameters used to embed
|   |   |   ├── embedding-002...                   
|   |   ├── umaps/
|   |   |   ├── umap-001.parquet                    # from umap.py, x,y coordinates
|   |   |   ├── umap-001.json                       # from umap.py, params used
|   |   |   ├── umap-001.png                        # from umap.py, thumbnail of plot
|   |   |   ├── umap-002....                        
|   |   ├── clusters/
|   |   |   ├── clusters-001.parquet                # from cluster.py, cluster indices
|   |   |   ├── clusters-001-labels-default.parquet # from cluster.py, default labels
|   |   |   ├── clusters-001-labels-001.parquet     # from label_clusters.py, LLM generated labels
|   |   |   ├── clusters-001.json                   # from cluster.py, params used
|   |   |   ├── clusters-001.png                    # from cluster.py, thumbnail of plot
|   |   |   ├── clusters-002...                     
|   |   ├── scopes/
|   |   |   ├── scopes-001.json                     # from scope.py, combination of embed, umap, clusters and label choice
|   |   |   ├── scopes-...                      
|   |   ├── tags/
|   |   |   ├── ❤️.indices                           # tagged by UI, powered by tags.py
|   |   |   ├── ...                                 # can have arbitrary named tags
|   |   ├── jobs/
|   |   |   ├──  8980️-12345...json                  # created when job is run via web UI
</pre>
