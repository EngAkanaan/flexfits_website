
import { GoogleGenAI } from "@google/genai";

const ai = new GoogleGenAI({ apiKey: process.env.API_KEY || '' });

export async function getProductRecommendation(prompt: string) {
  if (!process.env.API_KEY) return "AI recommendations currently unavailable.";
  
  try {
    const response = await ai.models.generateContent({
      model: 'gemini-3-flash-preview',
      contents: `You are an AI assistant for "FLEX Fits", a premium retail brand specializing in 100% authentic footwear and apparel. 
      The customer wants to know: ${prompt}. 
      Give a short, professional, and sophisticated recommendation about our products (Shoes, Tshirts, Socks, Hoodies). 
      Strongly emphasize that everything we sell is real, authentic, and never a copy. Keep it under 60 words.`
    });
    return response.text;
  } catch (error) {
    console.error("Gemini Error:", error);
    return "Something went wrong. Feel free to browse our authentic collections!";
  }
}
