import {
  Injectable,
  NotFoundException,
  BadRequestException,
} from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { Repository } from 'typeorm';
import { CreateExamDto } from './dto/create-exam.dto';
import { UpdateExamDto } from './dto/update-exam.dto';
import { Exam } from './entities/exam.entity';
import { Question } from '../questions/entities/question.entity';
import {
  resolveGeorgianExamRule,
  assertSufficientQuestionPool,
  InsufficientQuestionsError,
} from '../common/utils/georgian-exam-rules.util';
import { applyQuestionFilters } from '../questions/question-query.util';

interface GenerateExamOptions {
  lang: string;
  title?: string;
  subjects?: number[];
  categories?: number[];
  count?: number;
  allSubjects?: boolean;
}

@Injectable()
export class ExamsService {
  constructor(
    @InjectRepository(Exam)
    private readonly examRepo: Repository<Exam>,
    @InjectRepository(Question)
    private readonly questionRepo: Repository<Question>,
  ) {}

  async create(createExamDto: CreateExamDto) {
    const { title, questionIds, lang } = createExamDto as CreateExamDto & {
      questionIds?: number[];
      lang?: string;
    };

    const exam = this.examRepo.create({
      title,
      questionIds: questionIds ?? [],
      lang: lang ?? 'ka',
    });

    return this.examRepo.save(exam);
  }

  async generateExam(options: GenerateExamOptions) {
    const { lang, title, subjects, categories, count, allSubjects } = options;

    const examRule = resolveGeorgianExamRule({
      categories,
      count,
    });

    const filter = { lang, subjects, categories, allSubjects };
    if (categories?.length) {
      const countQb = this.questionRepo.createQueryBuilder('q');
      applyQuestionFilters(countQb, 'q', filter);
      const available = await countQb.getCount();
      try {
        assertSufficientQuestionPool(available, examRule);
      } catch (err) {
        if (err instanceof InsufficientQuestionsError) {
          throw new BadRequestException(err.message);
        }
        throw err;
      }
    }

    const qb = this.questionRepo.createQueryBuilder('q');
    applyQuestionFilters(qb, 'q', filter);
    const questions = await qb
      .orderBy('RANDOM()')
      .take(examRule.questionCount)
      .getMany();

    const exam = this.examRepo.create({
      title: title ?? 'Generated exam',
      lang,
      questionIds: questions.map((q) => q.id),
    });

    const saved = await this.examRepo.save(exam);
    return { ...saved, questions };
  }

  async findAll() {
    const exams = await this.examRepo.find({ order: { id: 'DESC' } });
    return Promise.all(exams.map((exam) => this.attachQuestions(exam)));
  }

  async findOne(id: string) {
    const numId = Number(id);
    if (!Number.isFinite(numId)) {
      throw new NotFoundException(`Exam with id "${id}" not found`);
    }

    const exam = await this.examRepo.findOne({ where: { id: numId } });
    if (!exam) {
      throw new NotFoundException(`Exam with id "${id}" not found`);
    }

    return this.attachQuestions(exam);
  }

  async update(id: string, updateExamDto: UpdateExamDto) {
    const numId = Number(id);
    if (!Number.isFinite(numId)) {
      throw new NotFoundException(`Exam with id "${id}" not found`);
    }

    const { title, questionIds, lang } = updateExamDto as UpdateExamDto & {
      questionIds?: number[];
      lang?: string;
    };

    const exam = await this.examRepo.findOne({ where: { id: numId } });
    if (!exam) {
      throw new NotFoundException(`Exam with id "${id}" not found`);
    }

    if (typeof title === 'string') exam.title = title;
    if (questionIds) exam.questionIds = questionIds;
    if (lang) exam.lang = lang;

    const saved = await this.examRepo.save(exam);
    return this.attachQuestions(saved);
  }

  async remove(id: string) {
    const numId = Number(id);
    if (!Number.isFinite(numId)) {
      throw new NotFoundException(`Exam with id "${id}" not found`);
    }

    const res = await this.examRepo.delete({ id: numId });
    if (!res.affected) {
      throw new NotFoundException(`Exam with id "${id}" not found`);
    }

    return { deleted: true };
  }

  private async attachQuestions(exam: Exam) {
    if (!exam.questionIds.length) {
      return { ...exam, questions: [] };
    }

    const questions = await this.questionRepo
      .createQueryBuilder('q')
      .where('q.lang = :lang', { lang: exam.lang })
      .andWhere('q.id IN (:...ids)', { ids: exam.questionIds })
      .getMany();

    return { ...exam, questions };
  }
}
