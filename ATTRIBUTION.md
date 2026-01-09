# Attribution and Data Sources

This project uses data and code from various sources. This document provides the required attribution and licensing information for all external dependencies.

## Map Data

### Overture Maps Foundation

This project uses building, base layer (land, water, land use), transportation, and divisions data from the [Overture Maps Foundation](https://overturemaps.org/).

> © OpenStreetMap contributors, Overture Maps Foundation

Overture Maps data incorporating OpenStreetMap is available under the [Open Database License (ODbL)](https://opendatacommons.org/licenses/odbl/).

- **Buildings**: Overture Maps buildings theme
- **Base Layer**: Land, water, land use, land cover, bathymetry
- **Transportation**: Roads, paths, railways
- **Divisions**: Administrative boundaries

For more information, see [Overture Maps Attribution](https://docs.overturemaps.org/attribution/).

### OpenStreetMap

Overture Maps data is derived from OpenStreetMap.

> © [OpenStreetMap](https://www.openstreetmap.org/copyright) contributors. Available under the Open Database License.

## Terrain Elevation Data

### AWS Terrain Tiles (Mapzen Terrarium)

Terrain elevation data is provided by the AWS Open Data Registry terrain tiles dataset, originally created by Mapzen (now a Linux Foundation project).

> Terrain Tiles was accessed from https://registry.opendata.aws/terrain-tiles/

The terrain tiles are a composite of multiple data sources, each with their own attribution requirements:

#### United States

**3DEP (formerly NED)**
> 3DEP data courtesy of the U.S. Geological Survey

**SRTM**
> SRTM data courtesy of the U.S. Geological Survey

**GMTED2010**
> GMTED2010 data courtesy of the U.S. Geological Survey

#### Global/Ocean

**ETOPO1**
> DOC/NOAA/NESDIS/NCEI > National Centers for Environmental Information, NESDIS, NOAA, U.S. Department of Commerce

#### New Zealand

**Land Information New Zealand (LINZ)**
> © Crown copyright (c) Land Information New Zealand and the New Zealand Government. Licensed under [CC BY 3.0 NZ](https://creativecommons.org/licenses/by/3.0/nz/).

#### United Kingdom

**UK Environment Agency LIDAR**
> © Environment Agency copyright and/or database right 2015. All rights reserved. Licensed under the [Open Government Licence v3](https://www.nationalarchives.gov.uk/doc/open-government-licence/version/3/).

#### Austria

**Austrian Digital Elevation Model (DGM)**
> © offene Daten Österreichs – Digitales Geländemodell (DGM) Österreich. Licensed under [CC BY 3.0 AT](https://creativecommons.org/licenses/by/3.0/at/).

#### Norway

**Kartverket**
> © Kartverket. Licensed under [CC BY 4.0](https://creativecommons.org/licenses/by/4.0/).

#### Arctic Regions

**ArcticDEM**
> DEM(s) were created from DigitalGlobe, Inc., imagery and funded under NSF awards 1043681, 1559691, and 1542736.

#### Europe

**EU-DEM**
> Produced using Copernicus data and information funded by the European Union - EU-DEM layers.

#### Canada

**Canadian Digital Elevation Model (CDEM)**
> Contains information licensed under the [Open Government Licence – Canada](https://open.canada.ca/en/open-government-licence-canada).

#### Mexico

**INEGI Continental Relief**
> Source: INEGI, Continental relief, 2016. Licensed under [INEGI Free Use Terms](https://www.inegi.org.mx/inegi/terminos.html).

#### Australia

**Australian Digital Elevation Model**
> © Commonwealth of Australia (Geoscience Australia) 2017. Licensed under [CC BY 4.0](https://creativecommons.org/licenses/by/4.0/).

For complete terrain tiles documentation, see [Tilezen Joerd Attribution](https://github.com/tilezen/joerd/blob/master/docs/attribution.md).

## Map Styling

### CARTO

Basemap styling provided by [CARTO](https://carto.com/).

> © CARTO

### MapLibre

Font glyphs for the minimap are provided by [MapLibre](https://maplibre.org/) demo tiles.

## 3D Assets

### Airplane Model

The Low Poly Airplane model (`plane.glb`) is sourced from [Fab.com](https://www.fab.com) under the Fab.com Standard License (EULA). See [Fab.com EULA](https://www.fab.com/eula) for full terms.

## Software Libraries

This project uses the following open-source libraries:

| Library | License | Purpose |
|---------|---------|---------|
| [Three.js](https://threejs.org/) | MIT | 3D rendering engine |
| [MapLibre GL JS](https://maplibre.org/) | BSD 3-Clause | Minimap rendering |
| [PMTiles](https://protomaps.com/docs/pmtiles) | BSD 3-Clause | Cloud-optimized tile format |
| [loaders.gl](https://loaders.gl/) | MIT | GLTF model loading |
| [earcut](https://github.com/mapbox/earcut) | ISC | Polygon triangulation |
| [Mapbox Vector Tile](https://github.com/mapbox/vector-tile-js) | BSD 3-Clause | Vector tile parsing |
| [pbf](https://github.com/mapbox/pbf) | BSD 3-Clause | Protocol buffer parsing |
| [PartyKit](https://partykit.io/) | MIT | Multiplayer WebSocket infrastructure |

## Geocoding

Location search functionality uses the [Overture Geocoder](https://www.npmjs.com/package/@bradrichardson/overture-geocoder), which is based on Overture Maps address data.

## License Summary

| Data/Asset | License | Attribution Required |
|------------|---------|---------------------|
| Overture Maps (Buildings, Base, Transportation, Divisions) | ODbL | Yes - OpenStreetMap & Overture |
| AWS Terrain Tiles | Various (see above) | Yes - Per data source |
| CARTO Basemaps | Proprietary | Yes |
| MapLibre GL JS | BSD 3-Clause | No |
| Three.js | MIT | No |
| Airplane Model | Fab.com EULA | Per EULA terms |

## In-Application Attribution

The minimap in this application displays the following attribution:

> © Overture Maps Foundation © OpenStreetMap contributors

---

*This attribution document was last updated: January 2026*

*For questions about attribution or licensing, please open an issue on the project repository.*
