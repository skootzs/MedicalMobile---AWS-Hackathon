export interface FormProperties {
  title: { locale: string; content: string }[];
  icon: string;
  context: { person: boolean; place: boolean; expression: string };
}

export function buildFormProperties(title: string, language: string, icon: string): FormProperties {
  return {
    title: [{ locale: language, content: title }],
    icon,
    context: { person: true, place: false, expression: "contact.type === 'person'" },
  };
}
