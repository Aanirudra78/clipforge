/**
 * Allowed b-roll query nouns.
 *
 * A stock library can only answer queries built around a *thing you can point a
 * camera at*. Left alone the LLM turns garbled ASR words ("asaphata", "chels")
 * into "topics", and the resulting footage is random. So the model may only
 * search nouns from this list, and the same list is enforced here after the
 * fact: a query without an allowed noun is refused (a text card beats unrelated
 * footage).
 *
 * Keep entries SINGULAR and lowercase; matching strips plurals.
 */
export const NOUNS = new Set(`
accident aeroplane airplane airport alley ambulance animal ant apartment app aquarium arcade arm armour army
arrow art artist baby backpack bag bakery balloon banana band bank bar barber barbecue barn basketball bat
bathroom battery beach bean beard bed bee beer bicycle bike bird blanket blood boat boat body book boot bottle
bowl box boy brain branch bread bridge brush bucket buffalo building bull bus bush butcher butter butterfly
cabbage cactus cafe cake calf camera camp canal candle cane canoe cap car caravan carpet carrot cart castle cat
cattle cave ceiling cello chain chalk champagne cheese chef cherry chess chicken child chimney chocolate church
cinema circle city classroom cliff clock cloth cloud coach coast coat coconut coffee coin cold college colour
comic computer concert container cook cookie copper coral corn cow crowd crown cry cube cup curtain cushion
dance dancer dawn deer desert desk dessert diamond diary dinner dinosaur dish doctor document dog doll
dollar donkey door dove dragon dress drone drum duck dust eagle ear earth egg electricity elephant elevator
email engine envelope exam eye eyebrow face factory farm feather fence ferry festival field film finger fire
firefighter firework fish flag flame flashlight flood floor flower flute fog food foot football forest fountain
fox fridge frog fruit fuel gallery game garage garbage garden garlic gas gate gem gift ginger giraffe glass
glove gold golf goose government graffiti grain grape grass gravel greenhouse guitar gun gym hair hammer hand
harbour hat hay headphone heart helicopter helmet hen highway hill hippo hive hockey hole honey horse hospital
hotel house ice insect instrument island jacket jail jar jet jewellery jungle keyboard kid king kitchen kite
kitten knee knife lab ladder lake lamp land lane laptop leaf leather leg lemon leopard library light lightning
lily lion lips lizard lock log lotus machine magnet makeup man mango map marble market mask match meal meat
medal medicine melon metal microphone milk mill mirror money monkey moon mosque motel motorbike motorcycle
mountain mouse mouth mud museum mushroom music nail necklace needle nest net newspaper night notebook nurse nut
ocean office oil olive onion orange orchestra oven owl ox oyster package paddle paint painting palace palm panda
panorama paper parachute parcel park parliament parrot pasta pastry path patient pattern pavement peach peacock
peanut pear pen pencil penguin pepper perfume petrol pharmacy phone photo piano picture pig pigeon pill pillow
plane planet plant plastic plate playground plum police pond pony pool pope poppy pot potato pottery powder
printer prison pumpkin puppy purse pyramid queen queue rabbit race radio rail railway rain rainbow rat raven
razor receipt recorder reef refrigerator restaurant rice ribbon rice ring river road robot rock rocket roof
room root rose rowboat rubber ruler run sack saddle safe sail sailor salad salmon salt sand sandwich satellite
sauce sausage scarf school scissors screen screw sea seal seat seed server shadow shark sheep shelf shell
ship shirt shoe shop shore shoulder shower shrine sign silver singer sink sitar skate ski skin skirt sky
sled sleep slide slum smoke snail snake snow soap sock sofa soil soldier soup space spider spoon sport spring
square squirrel stadium stage stairs stamp star statue steam steel step stick stone stool storm stove street
student submarine sugar suitcase sun sunset supermarket surgeon swimming sword table tablet tank tape taxi tea
teacher teenager telephone telescope television temple tent theatre thermometer thread throne thumb thunder
ticket tie tiger tile timber tin tire toast toe toilet tomato tongue tool tooth torch tower town toy
tractor trade traffic trailer train tree trench triangle truck trumpet trunk tunnel turkey turtle umbrella
uncle uniform valley van vegetable vehicle village vine violin wall wallet war warehouse watch water waterfall
watermelon wave wax weather web wedding well whale wheat wheel wheelchair whistle window wine wing wolf woman
wood wool worker workshop world worm wrist yacht yard yarn zebra zip zoo
tractor farmhouse orchard plantation
sugarcane crop harvest seedling nursery
podcast studio microphone host interview sofa
server datacenter code coding developer software app startup office desk
smartphone cover case party interior celebration crowd
chart graph map globe newspaper document
`.split(/\s+/).filter(Boolean));

const singular = (w) => {
  const t = String(w || '').toLowerCase().replace(/[^a-z]/g, '');
  if (!t) return '';
  if (t.length > 4 && t.endsWith('ies')) return `${t.slice(0, -3)}y`;
  if (t.length > 5 && t.endsWith('es') && NOUNS.has(t.slice(0, -2))) return t.slice(0, -2);
  if (t.length > 3 && t.endsWith('s') && !t.endsWith('ss')) return t.slice(0, -1);
  return t;
};

/** True when the query is built around at least one filmable noun. */
export function hasNoun(query) {
  return String(query || '').split(/\s+/).some((w) => NOUNS.has(singular(w)));
}

/** The allowed noun that carries a query, for logging/expansion. */
export function queryNoun(query) {
  return String(query || '').split(/\s+/).map(singular).find((w) => NOUNS.has(w)) || '';
}

/**
 * Adjectives / settings that make a noun query better without changing what is
 * on screen. Anything else (garbled ASR noise) is stripped.
 */
const MODIFIERS = new Set([
  'red', 'blue', 'green', 'yellow', 'black', 'white', 'golden', 'silver', 'brown', 'orange',
  'night', 'sunset', 'sunrise', 'aerial', 'drone', 'close', 'busy', 'crowded', 'empty', 'old',
  'rural', 'urban', 'indian', 'china', 'american', 'warm', 'rainy', 'snowy', 'small', 'large',
  'fresh', 'raw', 'cooked', 'hot', 'cold', 'indoor', 'outdoor', 'street', 'market', 'field',
]);

/**
 * Keep only tokens a stock library can understand. "thinerts tillers" becomes
 * "tillers"; "uninstall asaphata" becomes nothing and the row is refused.
 */
export function cleanQuery(q) {
  const words = String(q || '').toLowerCase().split(/\s+/)
    .map((w) => w.replace(/[^a-z]/g, ''))
    .filter(Boolean)
    .filter((w) => NOUNS.has(singular(w)) || MODIFIERS.has(w));
  if (!words.length || !words.some((w) => NOUNS.has(singular(w)))) return '';
  return words.slice(0, 3).join(' ');
}

/** Prompt fragment: the vocabulary the model is allowed to search with. */
export const NOUN_LIST = [...NOUNS].sort().join(', ');
