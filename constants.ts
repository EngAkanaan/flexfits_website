
import { Category, Product } from './types';

const SHOE_BASE_SIZES = Array.from({ length: 16 }, (_, i) => 35 + i);
const SHOE_SIZE_VARIANTS = ['', '(1/3)', '(1/2)', '(2/3)'];

const SHOE_SIZE_OPTIONS = SHOE_BASE_SIZES.flatMap((size) =>
  SHOE_SIZE_VARIANTS.map((variant) => `${size}${variant}`)
);

export const LEBANON_LOCATIONS: Record<string, Record<string, string[]>> = {
  "North Lebanon": {
    "Akkar": ["Halba", "Bebnine", "Qoubaiyat", "Andaket", "Bireh", "Fnaideq", "Miniara", "Mishmish", "Rahbeh", "Tal Abbas El Gharbi", "Tal Abbas El Sharqi"],
    "Tripoli": ["Tripoli", "Mina", "Qalamoun", "Beddawi", "Wadi Al Nahle"],
    "Zgharta": ["Zgharta", "Ehden", "Ardeh", "Rachaaine", "Kfarhata", "Kfarzayna", "Aintourine", "Sebhel"],
    "Bsharri": ["Bsharri", "Hadath El Jebbeh", "Hasroun", "Bazaoun", "Tourza", "Bane", "Qnat"],
    "Koura": ["Amioun", "Kousba", "Anfeh", "Kfarhazir", "Deddeh", "Btourram", "Bishmizzine", "Barsa", "Dar Baashtar", "Kefraya"],
    "Batroun": ["Batroun", "Koubba", "Ras Nhash", "Tannourine El Tahta", "Tannourine El Fawqa", "Tannourine Cedars", "Kfar Abida", "Chekka", "Hamat", "Douma", "Deir Billa", "Kfifane", "Hardine", "Ijdabra", "Kfar Hilda", "Smar Jbeil", "Ebrine"],
    "Minieh–Danniyeh": ["Minieh", "Sir El Danniyeh", "Bakhoun", "Bqarsouna", "Sfireh", "Aassoun", "Kfar Habou", "Beino", "Qarsita"]
  },
  "Mount Lebanon": {
    "Keserwan": ["Jounieh", "Kaslik", "Ghazir", "Ajaltoun", "Zouk Mosbeh", "Zouk Mikael", "Adma", "Jeita", "Faraya", "Faytroun"],
    "Jbeil": ["Jbeil", "Blat", "Amchit", "Ehmej", "Lehfed", "Aaqoura", "Annaya", "Mechmech"],
    "Metn": ["Jdeideh", "Antelias", "Bikfaya", "Dhour El Choueir", "Broummana", "Beit Mery", "Zalka", "Sin El Fil", "Baabdat", "Mansourieh"],
    "Baabda": ["Baabda", "Hazmieh", "Furn El Chebbak", "Chiyah", "Hadath", "Yarzeh", "Louaizeh"],
    "Aley": ["Aley", "Bhamdoun", "Souk El Gharb", "Ain Dara", "Bayssour", "Kahaleh", "Majdalaya"],
    "Chouf": ["Beiteddine", "Deir El Qamar", "Baakline", "Damour", "Barja", "Jiyeh", "Maasser El Chouf", "Ain Zhalta", "Mokhtara"]
  },
  "Beirut": {
    "Beirut": ["Beirut Central District", "Achrafieh", "Hamra", "Verdun", "Ras Beirut", "Ain El Mreisseh", "Gemmayzeh", "Mar Mikhael", "Basta", "Tariq El Jdideh"]
  },
  "South Lebanon": {
    "Sidon (Saida)": ["Sidon", "Ghazieh", "Miyeh w Miyeh", "Ain El Delb", "Maghdouche"],
    "Tyre (Sour)": ["Tyre", "Naqoura", "Qana", "Deir Qanoun", "Alma El Chaab", "Bint Jbeil (town)"],
    "Jezzine": ["Jezzine", "Kfarfalous", "Roum", "Lebaa", "Ain Majdalain"]
  },
  "Nabatieh": {
    "Nabatieh": ["Nabatieh", "Kfar Roummane", "Yohmor", "Doueir", "Habboush"],
    "Bint Jbeil": ["Bint Jbeil", "Aitaroun", "Maroun El Ras", "Rmeish", "Yaroun"],
    "Marjayoun": ["Marjayoun", "Khiam", "Qlayaa", "Bourj El Mlouk"],
    "Hasbaya": ["Hasbaya", "Kfar Shuba", "Chebaa", "Ain Qeniyeh"]
  },
  "Bekaa": {
    "Zahle": ["Zahle", "Chtaura", "Saadnayel", "Taalabaya", "Qabb Elias", "Ablah"],
    "Baalbek": ["Baalbek", "Douris", "Iaat", "Brital", "Nabi Chit"],
    "West Bekaa": ["Joub Jannine", "Saghbine", "Machghara", "Kamed El Lawz"],
    "Rashaya": ["Rashaya", "Kfar Qouq", "Ain Ata", "Mdoukha"],
    "Hermel": ["Hermel", "Qasr", "Boudai", "Hawsh Al Sayed Ali"]
  }
};

export const SIZE_OPTIONS = {
  [Category.SHOES]: SHOE_SIZE_OPTIONS,
  [Category.SOCKS]: ['35-40', '36-41', '40-45', '41-46', 'One Size'],
  [Category.UNDERWEAR]: ['XS', 'S', 'M', 'L', 'XL', 'XXL']
};

export const INITIAL_PRODUCTS: Product[] = [];

export const ADMIN_USER = 'AdamFlex';
export const ADMIN_PASS = 'Akanaan2025';
