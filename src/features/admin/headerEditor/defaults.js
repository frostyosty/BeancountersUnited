export const DEFAULT_CONFIG = {
    bgColor: '#263238', accentColor: '#f57c00', textColor: '#ffffff', pattern: 'none',
    mainText: 'MEALMATES', mainX: 50, mainY: 45, mainFont: "'Oswald', sans-serif", mainSize: 40, mainWeight: 700,
    subText: 'Food & Coffee', subX: 50, subY: 70, subFont: "Arial, sans-serif", subSize: 16, subWeight: 400,
    imgUrl: '', imgX: 80, imgY: 50, imgSize: 60
};

export const FONTS = [
    "'Oswald', sans-serif", 
    "'Playfair Display', serif", 
    "'Bebas Neue', cursive", 
    "'Dancing Script', cursive", 
    "'Pacifico', cursive", 
    "'Montserrat', sans-serif", 
    "'Roboto Slab', serif", 
    "'Righteous', cursive", 
    "'Merriweather', serif", 
    "Arial, sans-serif"
];

export const getFontOptionsHTML = () => {
    return FONTS.map(f => {
        const cleanName = f.split(',')[0].replace(/'/g, '');
        return `<option value="${f}">${cleanName}</option>`;
    }).join('');
};