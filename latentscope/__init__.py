from .__version__ import __version__
from . import models
from .scripts.embed import embed
from .scripts.embed import import_embeddings
from .scripts.umapper import umapper as umap
from .scripts.cluster import clusterer as cluster
from .scripts.scope import scope

from .server import serve

from .util import update_data_dir, get_data_dir, set_openai_key, set_voyage_key

def init(data_dir, env_file=".env", **kwargs):
  data_dir = update_data_dir(data_dir, env_file=env_file)
  setters = {
      'openai_key': set_openai_key,
      'voyage_key': set_voyage_key,
  }
  for key, setter in setters.items():
      if key in kwargs:
          setter(kwargs[key])
  print("Initialized env with data directory at", data_dir)

def main():
    import argparse
    parser = argparse.ArgumentParser(description='Initialize a data directory')
    parser.add_argument('data_dir', type=str, help='Directory to store data')
    parser.add_argument('--env_file', type=str, help='Path to .env file', default=".env")
    parser.add_argument('--openai_key', type=str, help='OpenAI API key')
    parser.add_argument('--voyage_key', type=str, help='Voyage API key')

    args = parser.parse_args()
    init(args.data_dir, args.env_file)